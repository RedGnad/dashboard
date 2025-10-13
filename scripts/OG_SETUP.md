# OpenGradient: Brancher sur le vrai service

Ce repo utilisait un proxy mock local pour les tests E2E. Voici comment activer le vrai service OG.

## 1) Choisir le mode côté backend Node

Dans `.env` (racine):

- `INFERENCE_PROVIDER=opengradient`
- `OG_PROXY_URL=http://127.0.0.1:8000` (temporaire: notre proxy Python)
- `OG_MODEL_ID=<votre_model_cid>` (ex: `meta-llama/Llama-3.1-70B-Instruct` ou CID du Model Hub)
- `OG_INFERENCE_MODE=VANILLA` (ou `TEE`/`ZKML` si supporté)
- `OG_PROVIDER_VERSION=og-http-v1`

Redémarrez l’API pour prise en compte.

## 2) Lancer le proxy Python (SDK officiel)

Le proxy expose `POST /inference` et utilise le SDK officiel pour appeler OG.

### Installer dépendances (dans un venv Python 3.10+)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r scripts/requirements.txt
```

### Variables d’environnement OG

- `OG_PRIVATE_KEY` (requis)
- `OG_EMAIL`, `OG_PASSWORD` (optionnels; selon votre accès)
- `OG_RPC_URL` (optionnel, défaut SDK)
- `OG_CONTRACT_ADDRESS` (optionnel)

### Démarrer

```bash
uvicorn scripts.og_proxy_fastapi:app --host 127.0.0.1 --port 8000 --reload
```

Vous devriez voir `service: og-proxy-fastapi` sur `http://127.0.0.1:8000/`.

## 3) Vérifier côté UI / API

- Appuyer sur “Provider” dans le panneau AI: `provider=opengradient` et `meta.baseUrl=http://127.0.0.1:8000`.
- “Preview” doit montrer `meta.inferenceProofHash` et `meta.baseUrl`. Le proxy renverra `meta.txHash` (hash OG) et éventuellement des métadonnées du modèle.
- “Proof Pack (download)”: ouvrez `manifest.json` et vérifiez `inferenceProofHash`.

## 4) Passer au vrai endpoint OG (sans proxy Python)

Si OG expose un endpoint HTTP direct pour votre cas d’usage:

- Remplacez `OG_PROXY_URL` par l’URL OG (ex: `https://api.opengradient.ai/...`).
- Si auth requise, on ajoutera l’en-tête Authorization dans `opengradientHttp.ts` (trivial à faire).

Sinon, conservez le proxy Python pour flexibilité (auth SDK, mapping output).

## 5) Vérifiabilité côté OG

- Le backend calcule `inferenceProofHash` (keccak du blob canonique). Le proxy renvoie `meta.receivedProofHash` et OG peut renvoyer `tx_hash`.
- Pour une preuve forte, demandez à OG une signature/attestation sur `inferenceProofHash` ou une ancre on-chain; ajoutez-la dans l’audit et le Proof Pack.
