# DCA Autonomous Wallet (Monad Testnet)

Minimal backend agent DCA using MetaMask Delegation Toolkit (v0.13) on Monad Testnet, with ERC-4337 userOperations and ERC-20 paymaster (ZeroDev/Pimlico compatible). Swaps USDC -> WMON (optional unwrap to MON) periodically without popups via off-chain delegations.

## Stack
- Node.js + TypeScript
- viem + @metamask/delegation-toolkit
- ERC-4337 BundlerClient + PaymasterClient (ZeroDev preferred; Pimlico fallback)
- Uniswap Universal Router for swaps

## Network
- Chain: Monad Testnet (chainId 10143)
- RPC: https://testnet-rpc.monad.xyz
- EntryPoint v0.7: 0x0000000071727De22E5E9d8BAf0edAc6f37da032
- Universal Router: 0x3ae6d8a282d67893e17aa70ebffb33ee5aa65893
- WMON: 0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701
- USDC (testnet): 0xf817257fed379853cDe0fa4F97AB987181B1E5Ea

## Env
Copy `.env.example` to `.env` and fill:
- RPC_URL
- ZERO_DEV_BUNDLER_RPC (or PIMLICO_BUNDLER_RPC)
- ZERO_DEV_PAYMASTER_RPC (or PIMLICO_PAYMASTER_RPC)
- DELEGATE_PRIVATE_KEY (agent signer)
- DCA_AMOUNT_USDC=1
- SLIPPAGE_BPS=100
- UNWRAP_TO_MON=true|false

## Run (dev)
- install deps
- run scheduler to execute every minute

Quick start:
- Copy .env.example to .env, fill RPC and ZeroDev URLs, and DELEGATE_PRIVATE_KEY test key.
- Start backend API (listens on :3000): npm start
- In another terminal, run the web app:
	- cd web && npm install && npm run dev
	- Open http://localhost:5173
	- Connect wallet, create & sign delegation, which posts to backend.
- Backend will detect delegations and can run a DCA userOperation.

## Notes
- Delegations are off-chain (ERC-7710) and attached to the userOperation during signing; no on-chain redeem necessary for 4337 Hybrid flow. Use Delegation Manager only if you opt into the on-chain redeem flow.
- Allowance management: approve USDC to Paymaster and Router when needed.

## Strategy AI (Stub) Endpoints
The stub strategy engine emits deterministic decisions and records them into the append-only audit log with integrity chaining.

- `GET /api/strategy/preview?delegator=0x..&volatility=0.42` => Simulates a DCA decision. Response includes `decision`, `aiRationaleHash`.
- `GET /api/strategy/history?limit=50&cursor=<rollingHash>&delegator=0x..` => Paginates `ai_decision` audit entries.
	- `limit` (default 50, max 200)
	- `cursor` = last `rollingHash` from prior page (exclusive)
	- `delegator` optional filter
Response: `{ ok, entries: [...], nextCursor, eof, total }`

Each `ai_decision` audit line includes:
```
aiRationaleHash, aiRiskScore, aiConfidence, strategyEngineVersion, aiActionType,
prevEntryHash, rollingHash (integrity chain)
```

## Audit Integrity Verification
An integrity chain is maintained across every audit line:
- `prevEntryHash` = keccak256(JSON string of previous line without mutation)
- `rollingHash` = keccak256(prevRollingHash || lineHash)

To verify locally:
Strict (toutes les lignes chaînées doivent correspondre):
```
npm run verify:audit
```
Mode tolérant (ignore les lignes legacy sans prevEntryHash ou genèse partielle):
```
npm run verify:audit -- --relaxed
```
Exemple sortie:
```
[verify] PASS lines=137 legacy=92 ai_decisions=12 finalRollingHash=0xabc123...
```
En cas d'altération: messages mismatch + code de sortie ≠ 0.

### Migration d'intégrité (rétroactive)
Si le log contient des lignes legacy sans `prevEntryHash` / `rollingHash`, vous pouvez recalculer une chaîne complète:
```
npm run audit:migrate:dry   # montre l'impact sans écrire
npm run audit:migrate       # applique (backup automatique)
```
Le script:
- Sauvegarde `audit.backup-<timestamp>.log`
- Recalcule pour chaque ligne: `prevEntryHash`, `rollingHash`
- Permet ensuite: `npm run verify:audit` (strict) → PASS
Note: Toute altération après migration invaliddera immédiatement la vérification stricte.

You can expose the current chain head via:
```
GET /api/delegations/audit/proof  -> { finalRollingHash, lines }
```

## Roadmap (Next)
- Enhanced strategy risk scoring
- /api/strategy/history additional filters (time window)
- External verifier script & reproducible hashing docs
- Web UI surfacing AI decision timeline & coverage stats

## HyperIndex / Envio Ingestion (Phase 1)

Phase 1 ingestion + feature hashing is implemented to prepare real model inputs.

### Endpoints
1. `POST /api/strategy/events/ingest`
	 Body:
	 ```json
	 {
		 "events": [
			 {
				 "id": "txhash:logIndex",
				 "ts": 1730000000000,
				 "chainId": 10143,
				 "type": "swap",
				 "price": 1.0023,
				 "amountQuote": "250.12",
				 "amountBase": "1000000000000000000",
				 "txHash": "0x...",
				 "blockNumber": 123456,
				 "meta": { "pool": "USDC/WMON" }
			 }
		 ]
	 }
	 ```
	 - Append-only write to `data/hyperindex/events.log` (JSONL)
	 - Duplicate `id` skipped

2. `GET /api/strategy/features/head`
	 Returns latest computed feature set over rolling windows (15m/1h/6h/24h) with `featureHash`.

### Feature Hashing
Serialization implemented in `src/hyperindex/schema.ts`:
- Lines: schemaVersion, asOfTs, each window spec, then sorted metrics `m:key=value`.
- UTF-8 join with `\n`, keccak256 → `featureHash`.

### AI Decision Integration
`/api/strategy/preview` now embeds:
```
featureHash, featureSchemaVersion
```
into each `ai_decision` audit line so later verification can recompute features and match the hash.

### UI
`AiConsole` shows a Feature Hash column (truncated). Missing hash => legacy or no events ingested yet.

### Next Steps
- Delegator-scoped feature subsets
- Guardrails (maxRiskScore, minConfidence) before executing
- Execution endpoint linking decisions → userOperations
- Export/verify remote proof bundle for feature + rationale reproducibility
- External Python model (OpenGradient) consuming feature set

## Autonomous Execution Loop

Endpoint: `POST /api/strategy/execute`

Body (JSON):
```
{ "rollingHash": "<optional ai_decision rollingHash>", "force": false }
```
If `rollingHash` omitted, the latest `ai_decision` line is used. If guardrails block the run and `force=true` is not set, no userOperation is sent.

Response (examples):
```
{ "ok": true, "correlationId": "...", "status": "blocked", "reason": "risk_score_exceeds_max", "decisionRollingHash": "0x..." }
{ "ok": true, "correlationId": "...", "status": "submitted", "userOperationHash": "0x...", "decisionRollingHash": "0x..." }
```

Guardrails config: `config/guardrails.json`
```
{
	"maxRiskScore": 70,
	"minConfidence": 0.55,
	"dailyCapUsd": 250,
	"minMinutesBetweenExec": 30,
	"maxExecutionsPer24h": 12
}
```
These are loaded with defaults and can be edited without restarting frequently (cache ~30s).

Audit correlation:
- `ai_decision` (existing) → later `execute` lines share `runId` (correlationId) and may include `userOperationHash`.
- Blocked executions append an `execute` line with `warnings: [guardrail_reason]`.
- Successful submission yields an `execute` line with `userOperationHash` (settlement still handled by resolver → `userop_settled`).

Planned enhancement: dedicated `run_requested` / `guardrail_block` actions (current phase reuses `execute` with warnings to minimize schema churn).


