# FastAPI OG proxy that calls the official OpenGradient Python SDK
# Exposes POST /inference expecting JSON payload similar to the Node side
# Requires environment variables:
#   OG_EMAIL (optional if using private_key only)
#   OG_PASSWORD (optional)
#   OG_PRIVATE_KEY (required by SDK)
#   OG_RPC_URL (optional; SDK has defaults)
#   OG_CONTRACT_ADDRESS (optional)
#
# Start locally: uvicorn scripts.og_proxy_fastapi:app --host 127.0.0.1 --port 8000 --reload

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Any, Dict, Optional
import os
import opengradient as og
from dotenv import load_dotenv
import math

app = FastAPI(title="og-proxy-fastapi")

@app.on_event("startup")
async def _init_og():
    # Charger .env et initialiser le SDK OG selon la méthode officielle (login -> init)
    try:
        load_dotenv()
    except Exception:
        pass
    pk = os.getenv("OG_PRIVATE_KEY")
    email = os.getenv("OG_EMAIL")
    password = os.getenv("OG_PASSWORD")
    network = os.getenv("OG_NETWORK")  # ex: 'devnet', 'mainnet' (selon docs OG)
    rpc_url = os.getenv("OG_RPC_URL")
    contract_address = os.getenv("OG_CONTRACT_ADDRESS")
    if not pk and not (email and password):
        print("[og-proxy] Missing OG_PRIVATE_KEY or OG_EMAIL/OG_PASSWORD; cannot init OG SDK.")
        return
    try:
        if email and password:
            og.login(email=email, password=password)
        # Préférer le paramètre 'network' officiel si fourni; sinon, si explicitement fournis, rpc/contract.
        if network:
            og.init(private_key=pk, network=network)
            print(f"[og-proxy] SDK initialized (network={network})")
        elif rpc_url or contract_address:
            og.init(private_key=pk, rpc_url=rpc_url, contract_address=contract_address)
            print(f"[og-proxy] SDK initialized (rpc_url={rpc_url}, contract={contract_address})")
        else:
            # Dernier recours: laisser le SDK utiliser ses défauts d'environnement
            og.init(private_key=pk)
            print("[og-proxy] SDK initialized (defaults)")
    except Exception as e:
        print("[og-proxy] SDK init failed:", e)

class InferenceBody(BaseModel):
    modelId: str
    features: Dict[str, Any]
    delegator: Optional[str] = None
    timestamp: Optional[int] = None
    featureHashV2: Optional[str] = None
    inferenceProofHash: Optional[str] = None
    inferenceMode: Optional[str] = "VANILLA"  # VANILLA | TEE | ZKML

def _seed_from_hex(h: Optional[str]) -> int:
    try:
        if isinstance(h, str) and h.startswith('0x') and len(h) >= 10:
            return int(h[2:10], 16)
    except Exception:
        pass
    return 123456789

def _synth_ohlc(volatility_simple: Optional[float], seed_hex: Optional[str]) -> list:
    # Deterministic OHLC[10][4] generator seeded by featureHashV2, scaled by volatilitySimple
    seed = _seed_from_hex(seed_hex)
    # Simple LCG PRNG
    def rnd():
        nonlocal seed
        seed = (1103515245 * seed + 12345) & 0x7fffffff
        return seed / 0x7fffffff
    base = 1.0
    vol = 0.01
    try:
        if isinstance(volatility_simple, (int,float)) and math.isfinite(volatility_simple):
            # bound and coarsen
            vol = max(0.001, min(0.05, float(volatility_simple)))
    except Exception:
        pass
    arr = []
    for i in range(10):
        o = base * (1 + (rnd()-0.5) * vol)
        high = o * (1 + vol * 0.5)
        low = o * (1 - vol * 0.5)
        c = o * (1 + (rnd()-0.5) * vol)
        arr.append([float(f"{o:.6f}"), float(f"{high:.6f}"), float(f"{low:.6f}"), float(f"{c:.6f}")])
        # small drift for next bar
        base = c
    return arr

@app.get("/")
async def root():
    return {"ok": True, "service": "og-proxy-fastapi", "endpoints": ["/inference"]}

@app.post("/inference")
async def inference(body: InferenceBody):
    # Explicit stub mode only if the env flag is ON; otherwise never stub
    try:
        v = os.getenv("OG_PROXY_FORCE_STUB", "").strip().lower()
        if v in ("1", "true", "yes", "on"):
            # Minimal explicit stub for controlled local testing only
            feats = body.features or {}
            try:
                alloc_dev = float(feats.get('allocationDeviation', 0) or 0)
                vol = float(feats.get('volatilitySimple', 0.35) or 0.35)
                base = 0.5 - alloc_dev * 0.25
                adj = (0.3 - min(max(vol, 0.0), 1.0)) * 0.1
                score = max(0.0, min(1.0, base + adj))
            except Exception:
                score = 0.55
            return {
                "ok": True,
                "score": float(score),
                "z": 0.0,
                "modelHash": None,
                "weightsUsedHash": None,
                "meta": {
                    "txHash": None,
                    "receivedProofHash": body.inferenceProofHash,
                    "inferenceMode": (body.inferenceMode or "VANILLA").upper(),
                    "forcedStub": True,
                }
            }
    except Exception:
        pass
    # Resolve inference mode enum robustly across SDK variants
    mode_str = (body.inferenceMode or "VANILLA").upper()
    mode_param = None
    try:
        ModeEnum = getattr(og, 'InferenceMode', None)
        if ModeEnum is not None:
            mode_param = getattr(ModeEnum, mode_str, getattr(ModeEnum, 'VANILLA', None))
        if mode_param is None and hasattr(og, 'types') and hasattr(og.types, 'InferenceMode'):
            TEnum = getattr(og.types, 'InferenceMode')
            mode_param = getattr(TEnum, mode_str, getattr(TEnum, 'VANILLA', None))
    except Exception:
        mode_param = None
    if mode_param is None:
        mode_param = mode_str

    # Build model_input from provided features; adapt if model expects OHLC array
    feats = body.features or {}
    model_input: Dict[str, Any]
    if isinstance(feats, dict) and 'open_high_low_close' in feats:
        model_input = feats
    else:
        v = feats.get('volatilitySimple') if isinstance(feats, dict) else None
        model_input = {
            'open_high_low_close': _synth_ohlc(v, body.featureHashV2)
        }

    # Try real SDK call; do NOT fallback silently
    try:
        # First, try the model_cid signature
        tx_hash, output = og.infer(model_cid=body.modelId, inference_mode=mode_param, model_input=model_input)
        score = None
        z = None
        if isinstance(output, dict):
            score = output.get("score")
            z = output.get("z")
        result = {
            "ok": True,
            "score": float(score) if isinstance(score, (int, float)) else None,
            "z": float(z) if isinstance(z, (int, float)) else None,
            "modelHash": output.get("modelHash") if isinstance(output, dict) else None,
            "weightsUsedHash": output.get("weightsUsedHash") if isinstance(output, dict) else None,
            "meta": {
                "txHash": tx_hash,
                "receivedProofHash": body.inferenceProofHash,
                "inferenceMode": mode_str,
            }
        }
        if result["score"] is None:
            result["meta"]["rawOutput"] = output
        return result
    except Exception as e1:
        # Surface the original SDK error; do not try alternate signatures
        raise HTTPException(status_code=502, detail={
            "error": f"og.infer failed: {str(e1)}",
            "modelId": body.modelId,
            "inferenceMode": mode_str,
        })
