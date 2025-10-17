# OpenGradient integration (HTTP proxy)

This repo can call a local OpenGradient proxy to run real inference while preserving a verifiable trail via inferenceProofHash. As an alternative while OG devnet funding is unavailable, you can switch to a real OpenAI provider.

- Provider modes: INFERENCE_PROVIDER=local | opengradient-stub | opengradient | openai
- HTTP provider env:
  - OG_PROXY_URL=http://127.0.0.1:8000
  - OG_MODEL_ID=openai/gpt-4o-mini (or your model URI as your proxy expects)
  - OG_PROVIDER_VERSION=og-http-v1

Quick start proxy (example FastAPI):
- POST /inference with body { modelId, features, delegator, timestamp, featureHashV2, inferenceProofHash }
- Respond { ok: true, score, z?, modelHash, weightsUsedHash?, meta? }
- The server computes score using OG Python SDK and returns a stable modelHash.

Verification narrative:
- We serialize a canonical blob with provider, version, modelId, featureHashV2, delegator, ts and hash it (inferenceProofHash).
- The proof hash is written into ai_decision lines and packaged in proof packs (inference.json + manifest.inferenceProofHash).
- Auditors can recompute the hash locally from decision fields without re-running inference.

Notes:
- If your proxy changes modelId or provider version, the proof hash changes; keep them stable for a given model.
- Keep featureHashV2 stable by using the provided featuresCanonical and featureHashV2 pipeline.

OpenAI mode:
- Set INFERENCE_PROVIDER=openai
- Set OPENAI_API_KEY=sk-...
- Optional OPENAI_MODEL=gpt-4o-mini (default)
- The inference result is a true remote call; we expect a JSON-only assistant message with { score, z? }.
