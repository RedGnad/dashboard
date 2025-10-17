# DCA Autonomous Wallet — Hackathon Pitch (MetaMask Smart Accounts × Monad)

Elevator pitch
- An autonomous DCA agent on Monad Testnet that decides BUY/SELL/SKIP using a pluggable inference layer (OpenGradient Swarm stub or local deterministic model) and on-chain-grade spot prices from Switchboard — while proving every step with cryptographic evidence: chained audit (rollingHash), deterministic feature/model/inference hashing, replay, guardrails v2, and a portable Proof Pack you can verify locally.
- No black box: every decision is hash-linked, reproducible, oracle-backed, and independently verifiable.

What it showcases (hackathon-aligned)
- MetaMask Smart Accounts + Delegations (ERC-7710): create/sign a delegation in the web UI and execute via 4337 UserOperations; no opaque backend signing.
- Monad Testnet integration: uses Monad RPC and Universal Router; low-latency demo-ready flow.
- Verifiable AI decisions: featureHashV2 (timestamp-agnostic), modelHash, inferenceProofHash (OG stub), aiRationaleHash, strict audit chain (prevEntryHash + rollingHash).
- Switchboard Oracle (Surge): spot price with deterministic quantization and safe fallback; exposed as `priceQuantized` (v3) to stabilize hashing.
- Guardrails v2: risk/confidence caps, spacing, daily caps, volatility drift, feature staleness, hash mismatch detection (optional hard block).
- Proof Pack export/verify: bundle decision + features + events + manifest; two-phase canonical hashing; CLI verify script.

3-minute demo script
1) Start API + Web, connect wallet
   - Backend at :8787, Web at :5173; connect a test wallet.
2) Create delegation in UI and post to backend
   - Signs an off-chain ERC-7710 delegation using @metamask/delegation-toolkit.
3) Preview decision and show evidence
   - Open /api/strategy/decision/latest or UI panel; point to featureHashV2, modelHash, inferenceProofHash (when OG stub enabled), aiRationaleHash, rollingHash.
   - Toggle INFERENCE_PROVIDER between local and opengradient_stub to show the pluggable execution layer.
4) Verify locally in one command
   - Run verify:all (aggregates audit, latest, hyperindex, guardrails, proof-pack, replay, live parity); show PASS summary.
5) Spot price provenance
   - Enable ENABLE_SWITCHBOARD=1; show `priceQuantized` in features (v3 shadow), confirm stability across runs.
6) Execute once (if guardrails allow)
   - POST /api/strategy/execute → returns status submitted/blocked, with userOperationHash when submitted.
7) Export Proof Pack and verify
   - GET /api/strategy/proof-pack/latest?anchor=1 → save; run verify:proof-pack → OK match <hash>.

Architecture (short)
- Backend (Node/TS, Express): audit chain, strategy engine, guardrails, HyperIndex (features), Proof Pack builder, verification endpoints, SSE.
- Web (React + Vite + wagmi): connect wallet, build/post delegations, live verification dashboard (hashes, guardrails, hyperindex, proof pack, replay buttons).
- Data: append-only logs in data/, portable proof-packs in data/proof-packs/.

Key endpoints for judges
- GET /api/_routes — discovery
- GET /api/strategy/decision/latest — latest decision + inline verification
- GET /api/strategy/decision/replay?mode=strict-snapshot — reproducibility
- GET /api/strategy/features/head — feature set + featureHash
- GET /api/strategy/guardrails/head — status (blocked/warnings)
- POST /api/strategy/execute — autonomous execution loop
- GET /api/strategy/proof-pack/latest?anchor=1 — portable bundle (+ X-Pack-Keccak256 header)
- GET /api/audit/stream — audit SSE

How it uses MetaMask Smart Accounts
- Delegation creation & signing via @metamask/delegation-toolkit in the web app.
- 4337 bundler + paymaster (ZeroDev preferred; Pimlico fallback) for userOps.
- Off-chain delegations attached during signing; on-chain Delegation Manager optional.

How it uses Monad
- ChainId 10143, RPC https://testnet-rpc.monad.xyz, Universal Router integrated for swaps.
- Low-latency environment for quick end-to-end userOp submissions.

Proof story (trust, not promises)
- Integrity chain: prevEntryHash + rollingHash across every audit line.
- Feature hashing: canonical v2 without timestamps for stable snapshots; v3 adds oracle-based `priceQuantized`.
- Model hashing: deterministic modelHash ties the decision to a specific model snapshot.
- Inference hashing: `inferenceProofHash` proves the inference pre-image for Swarm provider.
- Proof Pack: canonical, two-phase hashing ensures no self-reference; CLI re-computation matches packKeccak256.
- Live parity: verify:live compares server-exposed rolling head vs local reconstruction.

Fast start (local)
- Root package.json scripts: start API, verify:all, replay:decision, build/verify-proof-pack.
- Web: cd web && npm run dev; open http://localhost:5173 and connect wallet.

Judging checklist mapping
- Smart Accounts: Delegation-based execution via 4337; no private backend signing.
- Monad: Testnet integration, live userOp submission, Universal Router usage.
- Security: Guardrails v2, auto-revoke (HyperIndex anomaly), config reload + hash.
- Verifiability: replay, deterministic hashing, Proof Pack export/verify, anchors log.
- UX: Dashboard with hashes, guardrails, hyperindex, proof pack verification.

Nice-to-have (backlog if time allows)
- Switchboard price oracle adapter on (ENABLE_SWITCHBOARD=1) and include priceQuantized in v3 features.
- Inference provider abstraction with OpenGradient stub (inferenceProofHash) and audit fields.
- One-click “Verify All” button in the dashboard that runs endpoints & client-side re-hash.

One-liner tagline
- An autonomous DCA wallet for Monad that proves every decision — hashed, chained, and replayable.
