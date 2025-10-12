# DCA Autonomous Wallet (Monad Testnet)

Autonomous DCA + AI decision engine prototype with **cryptographically verifiable provenance** (strict audit hash chain, deterministic feature/model hashing, replay, portable Proof Pack, off‑chain anchoring, guardrails v2).

Core trust properties:
1. Chaque décision est chaînée (`prevEntryHash`, `rollingHash`).
2. Features sérialisées canoniquement → `featureHash` + variante stable temps (`featureHashV2`).
3. Modèle & poids → `modelHash`, `weightsUsedHash`.
4. Justification → `aiRationaleHash` (pas besoin de conserver le texte clair pour vérifier l’intégrité).
5. Rejouabilité multi modes: `basic`, `strict`, `strict-snapshot`.
6. Export portable: Proof Pack (hash canonical en 2 phases) vérifiable via CLI.
7. Anchoring off‑chain périodique (manual ou auto scheduler) des têtes `rollingHash` + `packKeccak256`.
8. Guardrails v2: drift volatilité, staleness features, *feature hash mismatch* (blocage dur configurable) + règles risk/confidence/spacing/caps.
9. Suite CLI de vérification couvrant audit, hyperindex, décision, pack, guardrails.
10. Vérification live (hash local vs API) via `verify:live` intégrée dans `verify:all`.

TL;DR: "Pas de boîte noire" – toute décision est **portable, rejouable, vérifiable**.
## Stack
- Node.js + TypeScript
- viem + @metamask/delegation-toolkit
- ERC-4337 BundlerClient + PaymasterClient (ZeroDev preferred; Pimlico fallback)
- Uniswap Universal Router for swaps
- Inference providers: deterministic local model (TS) and OpenGradient Swarm (stub) via a pluggable provider
- Spot price oracles: Switchboard (Surge) adapter with deterministic quantization and safe fallback

## AI Execution Layer (Swarm) & Spot Price Oracles

Pourquoi c’est central:
- Le moteur d’inférence peut être fourni par un provider distribué (OpenGradient Swarm) pour la robustesse et l’ouverture. Chaque appel produit un blob canonique hashé (`inferenceProofHash`) qui s’intègre à la chaîne de preuves (audit + Proof Pack v2).
- Le prix spot provient d’un oracle externe (Switchboard) avec quantization (6 décimales) pour stabiliser les hashes; un fallback synthétique est conservé si l’oracle est indisponible.

Contrats d’interface (résumé):
- InferenceProvider: prend `featuresCanonical`, renvoie `decision` + `meta` + `inferenceProofHash`.
- PriceProvider: `getSpot(symbol)` → `{ price, conf?, ts }`, avec cache TTL court et `quantizePrice()`.

Variables d’environnement clés:
- INFERENCE_PROVIDER=local | opengradient_stub | openai
- OG_MODEL_CID, OG_INFERENCE_MODE (métadonnées)
- ENABLE_SWITCHBOARD=1, SWITCHBOARD_API_KEY, SWITCHBOARD_ENDPOINT
- SWITCHBOARD_SYMBOLS=WMON/USD[,BTC/USD], SWITCHBOARD_STALE_MS=15000

Preuves associées:
- Audit: ajout de `inferenceProofHash` (et `inferenceProvider`).
- Proof Pack v2: ajout `inference.json` (blob canonique OG) au bundle; `packKeccak256` reconstruit à l’identique.

Voir `INFERENCE_ORACLES.md` pour le détail des invariants et la feuille de route d’intégration.

## Network
Voir aussi: `ARCHITECTURE_TRUST.md` pour les invariants cryptographiques détaillés.
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

#### Migration en mode quiescent (recommandé)
Pour éviter qu'une entrée `guardrails_config` ou autre ne soit ajoutée pendant le recalcul:
```
npm run api:stop
npm run audit:migrate:dry
npm run audit:migrate
npm run verify:audit
npm run api:start
```
Si de nouvelles lignes arrivent immédiatement après (ex: reload config), répéter la procédure; chaque run laisse un backup.

### Procédure de Migration Sûre (Post Phase Sécurité)
Depuis l'ajout du recalcul canonique (hash de la ligne sans `rollingHash`) et du drop forcé des champs fournis par l'appelant, suivre cette séquence pour éviter toute rupture:
```
# 1. Stop API pour figer les écritures
npm run api:stop

# 2. (Optionnel) Activer verrou manuel si nécessaire
# node -e "require('./dist/audit.js').createAuditLock()" (si build dist)

# 3. Migration
npm run audit:migrate

# 4. Vérification stricte
npm run verify:audit

# 5. Redémarrer
npm run api:start
```
Variables recommandées en exécution:
```
AUDIT_VERIFY_ON_APPEND=1      # Vérifie immédiatement la dernière ligne append
AUDIT_REFUSE_STALE=1          # Refuse toute append avec prevEntryHash obsolète fourni par un caller legacy
```
Protection runtime:
- Toute ligne append a son `prevEntryHash` recalculé; ceux fournis sont ignorés.
- Si `AUDIT_REFUSE_STALE=1`, une tentative avec un `prevEntryHash` différent du calcul local est rejetée (aucune écriture).
- Log d'avertissement en cas de réécriture silencieuse (sans le flag de refus).


You can expose the current chain head via:
```
GET /api/delegations/audit/proof  -> { finalRollingHash, lines }
```

## Roadmap (Next)
- Intégrer InferenceProvider + OpenGradient (stub) et ajouter `inferenceProofHash` dans l’audit
- Proof Pack v2 incluant `inference.json` et scripts de re-hash du blob d’inférence
- Activer Switchboard pour le prix spot (quantization + fallback) et exposer `priceQuantized`
- Enhanced strategy risk scoring
- /api/strategy/history additional filters (time window)
- External verifier script & reproducible hashing docs
- Web UI surfacing AI decision timeline & coverage stats

## Verification & Replay (Deterministic AI Provenance)

### Résumé Rapide
Chaque décision AI est:
- Chaînée cryptographiquement (`prevEntryHash` + `rollingHash`)
- Hashée avec ses features (`featureHash` + `featureHashV2` sans timestamp)
- Reliée à un modèle déterministe (`modelHash`, `weightsUsedHash`)
- Rejouable via endpoint ou script (`/api/strategy/decision/replay` / `npm run replay:decision`)

### Vérifier la dernière décision (API)
```
curl -s http://localhost:8787/api/strategy/decision/latest | jq
```
Résultat: `{ ok, decision, verification: { pass, checks } }`.

### Rejouer (modes)
```
curl -s 'http://localhost:8787/api/strategy/decision/replay?mode=basic'
curl -s 'http://localhost:8787/api/strategy/decision/replay?mode=strict'
curl -s 'http://localhost:8787/api/strategy/decision/replay?mode=strict-snapshot'
```
`strict-snapshot` re-hash `featuresCanonical` (v1 & v2) + présence des champs provenance.

### Script CLI (dernière décision)
```
npm run replay:decision -- --strict-snapshot
```
Pour cibler un `rollingHash` précis:
```
npm run replay:decision -- --rolling 0xabc123...
```

### Vérifier seulement l’intégrité des features & provenance
```
npm run verify:latest
```
Renvoie PASS/FAIL + diffs.

### Hash Fields
| Champ | Rôle |
|-------|------|
| `prevEntryHash` | Hash de la ligne précédente (garantie d’ordre) |
| `rollingHash` | Chaîne cumulative — ancre de confiance actuelle |
| `featureHash` | Hash brut des features (inclut éventuellement `ts=`) |
| `featureHashV2` | Hash strict sans lignes `ts=` pour reproduction snapshot |
| `aiRationaleHash` | Hash du texte de justification (pas besoin de stocker le texte en clair) |
| `modelHash` | Signature immuable du modèle |
| `weightsUsedHash` | Empreinte des poids triés |
| `rawScore` / `logitZ` | Traces numériques internes pour ré-calcul |

### Live Divergence Check
Script: `npm run verify:live` — compare le `finalRollingHash` local (recalculé directement depuis `audit.log`) à celui exposé par l'API (`/api/strategy/state`). Sortie unique normalisée:
```
[verify-live] status=<ok|mismatch|server_unreachable_or_invalid|live_missing_hash> live=<hash|none> local=<hash> match=<true|false>
```
Dans `verify:all`, ce check est toujours soft: une divergence ne renvoie pas code 2 mais signale un état à investiguer.

### Ensemble de vérification agrégée (`verify:all`)
Commande: `npm run verify:all`

Étapes exécutées (ordre):
1. `verify:audit` (hard) – recalcul strict de chaîne.
2. `verify:latest` (hard) – décision courante.
3. `verify:hyperindex` (soft) – cohérence HyperIndex.
4. `build:proof-pack` (hard) – construction bundle canonique.
5. `verify:proof-pack` (hard) – re-hash et comparaison.
6. `verify:guardrails` (soft) – état guardrails.
7. `verify:live` (soft) – divergence serveur.
8. `replay:decision` (soft par défaut) – déterminisme.
9. `test:determinism` (soft par défaut) – test scripté (features/model/action).

Codes sortie:
- 0: tout hard OK, aucun soft fail.
- 1: au moins un soft fail (hard OK).
- 2: au moins un hard fail.

Élévation (rendre certains steps hard):
- `VERIFY_ALL_HARD_REPLAY=1` → `replay-latest` devient hard.
- `VERIFY_ALL_HARD_DETERMINISM=1` → `determinism` devient hard.

Bonnes pratiques:
- Activer flags hard en CI pour empêcher dérives subtiles.
- Garder soft en dev local pour itérer sans bruit.

## Dashboard
Le frontend (section *AI Verification Dashboard*) affiche:
- Statut de vérification (PASS/FAIL)
- Boutons de replay (basic / strict / strict-snapshot)
- Derniers hashes (rolling, features v1/v2, rationale)
- Flux SSE temps réel (/api/audit/stream) des dernières lignes
- Statistiques d’efficacité & guardrails (/api/strategy/effectiveness)
- Diff guardrails (champ `diff` dans `/api/strategy/guardrails/head`) listant `{ key, prev, next }`.
- Proof Pack re-hash local (reconstruction pré-image côté navigateur) → confirme `packKeccak256`.
- État replay détaillé (basic / strict / strict-snapshot) avec PASS/FAIL par mode.

### Protocol Metrics (Envio / RPC)
Le panneau “Protocol Metrics” consomme `/api/metrics/protocols/daily`.
- Source préférée: Envio HyperIndex GraphQL (`ENVIO_GRAPHQL_URL`).
- Si Envio est indisponible, l’API bascule automatiquement sur un scan RPC rapide (fenêtre récente) pour garder la vue utile.

Voir `docs/metrics.md` pour les détails (variables d’environnement et paramètres de requête).

Exemple d'état strict FAIL typique: divergence `featureHashV2` (ex: sérialisation locale vs distante) ou mismatch modèle.

## SSE Streaming
Endpoint: `GET /api/audit/stream`
Événements:
- `init`: taille courante du fichier
- `line`: chaque nouvelle ligne JSON appended (contient parfois `rollingHash`, `aiActionType`…)

## Dynamic Route Listing
```
curl -s http://localhost:8787/api/_routes | jq
```
Permet introspection rapide pour la démo hackathon.

## Anchoring (Off-chain Lightweight)
Objectif: attester régulièrement la tête `rollingHash` et le hash de Proof Pack pour détection de fork ou réécriture.

Endpoints:
- `POST /api/audit/anchor` → append dans `data/delegations/anchors.jsonl` (legacy anchor pour rollingHash uniquement)
- `GET  /api/strategy/anchors` → liste des 50 derniers anchors (pack + rolling)
- `POST /api/strategy/anchors` body `{ packKeccak256, rollingHash }` → append manual

Lors de l'obtention d'un Proof Pack (`/api/strategy/proof-pack/latest?anchor=1`), un enregistrement est ajouté dans `data/anchors.log` avec:
```
{ ts, anchorRef, packKeccak256, rollingHash, rollingHashHeight, featureHash, decisionRollingHash }
```
`anchorRef` n'est PAS incluse dans le pré-image de hash du pack; le hash `packKeccak256` reste stable qu'il y ait ancrage ou non.

### Proof Pack (Export Verifiable)
Endpoint: `GET /api/strategy/proof-pack/latest` (gzip JSON). Fichiers inclus:
```
decision.json  (dernière ai_decision)
features.json  (features head au moment du build)
events.jsonl   (slice d'évènements nécessaires aux features)
rolling.txt    (tête rollingHash + height)
manifest.json  (metadonnées + packKeccak256)
```
Canonical hashing process:
1. Construire `manifestProvisional` (sans `packKeccak256`, sans `anchorRef`).
2. Ajouter chaque fichier (contenu brut UTF-8) dans un objet `{ files: [...] }` + `manifest.json` provisoire.
3. keccak256(JSON stringify du bundle) → `packKeccak256`.
4. Émettre `manifestFinal = manifestProvisional + packKeccak256 (+ anchorRef optionnel)`.
5. Re-générer bundle final (hash identique car pré-image exclut `packKeccak256`).

CLI vérification (reconstruit le pré-image) :
```
npm run verify:proof-pack -- path/to/pack.json.gz
```
Sortie : `OK match <hash>` ou mismatch + code de sortie ≠ 0.

Usage typique:
```
curl -s -D headers.txt http://localhost:8787/api/strategy/proof-pack/latest?anchor=1 --output pack.json.gz
npm run verify:proof-pack -- pack.json.gz
```
Le header `X-Pack-Keccak256` expose également le hash.

### Debug & Pre-image
Endpoint: `/api/proof-pack/debug` – renvoie une vue non compressée + fichiers avant hashing final. Utile pour inspection UI. Si votre tableau de bord affiche `Erreur: Not Found`, vérifier que le serveur tourne sur le port attendu et que la route est incluse (voir `server.ts` vers la fin: handler `/api/proof-pack/debug`).

## Guardrails v2
Extension des guardrails d'exécution pour inclure détection proactive:

Règles existantes (blocking):
- `risk_score_exceeds_max`
- `confidence_below_min`
- `max_exec_24h_reached`
- `daily_cap_reached`
- `min_spacing_not_elapsed`

Nouvelles analyses (v2):
- `volatility_drift_exceeds_threshold` (warning) — différence absolue entre `volatilitySimple` courante et la dernière décision > `maxVolatilityDrift`
- `features_stale` (warning) — âge features > `maxFeatureAgeMs`
- `feature_hash_mismatch` / `feature_hash_v2_mismatch` — mismatch avec la dernière décision (hard block si `hashMismatchHardBlock=true`)

Nouveaux champs sur `ai_decision`:
```
guardrailBlocked: bool
guardrailReason: string | undefined
guardrailWarnings: string[]
```

Endpoint synthèse head:
```
GET /api/strategy/guardrails/head -> { evaluation: { blocked, reason, warnings, info: { featureAgeMs, volatilityDrift } } }
```

Config (merge avec defaults) : `config/guardrails.json`
```jsonc
{
	"maxRiskScore": 80,
	"minConfidence": 0.5,
	"dailyCapUsd": 500,
	"minMinutesBetweenExec": 15,
	"maxExecutionsPer24h": 24,
	"maxVolatilityDrift": 0.35,
	"maxFeatureAgeMs": 300000,
	"hashMismatchHardBlock": true
}
```
Rechargement: `POST /api/strategy/guardrails/reload`.

Test unitaire V2: `tests/guardrails.test.ts` (drift, stale, mismatch, clean).

UI Dashboard: panneau “Guardrails” affiche status (BLOCKED/clear), warnings, drift et âge des features.

## Export Snapshot
Endpoint: `GET /api/strategy/decision/export/latest`
Renvoie un JSON téléchargeable (`decision-snapshot.json`) avec subset minimal pour replay strict local (`featuresCanonical`, `inferenceFeatures`, provenance de modèle).

## Schéma (Mermaid)
```mermaid
flowchart LR
	A[Collect Features] --> B[Canonical Serialize]\nB --> C1[featureHash]\nB --> C2[featureHashV2]
	A --> M[Deterministic Model]
	M --> S[Score & z]
	S --> Map[Mapping -> action,risk,confidence]
	Map --> R[aiRationaleHash]
	C1 --> L[Audit Line]
	C2 --> L
	R --> L
	M --> H[modelHash]
	H --> L
	L --> CHAIN[rollingHash chain]
	CHAIN --> Replay[Replay & Verification]
```

## TL;DR
"Pas de boîte noire": chaque décision AI = hashée, chaînée, rejouable et vérifiable publiquement.

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
## Strategy AI & Decision Provenance
The deterministic strategy layer emits decisions into an append‑only audit log with a strict rolling integrity chain and full provenance hashes.
## Constantes de Version & Prix

| Constante | Rôle | Valeur actuelle |
|-----------|------|-----------------|
| `FEATURE_SET_VERSION` | Sélectionne schéma de features (v2 stable, v3 enrichi) | 2 |
| `MAPPING_VERSION` | Version de la fonction score→décision | map-v1 |
| `finalRollingHash` | Ancre intégrité audit actuelle | 0x03155a...ef5b |

### Abstraction Prix
Fichier: `src/pricing/provider.ts`
Composants:
- SyntheticPriceProvider: dérive prix déterministe (placeholder / fallback).
- SwitchboardStub: squelette pour feed oracle externe.
- CompositeProvider: tente oracle, fallback synthétique.

Quantization: `quantizePrice(value)` (arrondi 6 décimales) — stabilise hash futur (v3) contre bruit micro-secondes / feed.

Intégration actuelle: prix capturé mais non encore inclus dans `featureHashV2`; sera ajouté dans v3 (`priceQuantized`).

## CLI Verification Suite
| Script | But |
|--------|-----|
| `verify:audit` | Re-hash complet de la chaîne audit (strict) |
| `audit:migrate[:dry]` | Recalcule `prevEntryHash` & `rollingHash` legacy → strict |
| `replay:decision` | Rejoue dernière ou cible `--rolling` (modes basic/strict/strict-snapshot) |
| `verify:latest` | Vérifie juste la décision courante (hashes & champs critiques) |
| `verify:all` | Orchestration complète (audit, pack, replay, guardrails, live) |
| `verify:proof-pack` | Re-hash d'un Proof Pack exporté |
| `test:determinism` | Test scripté stabilité features/model/action |
| `ci:verify` | Exécution combinée (hard replay/determinism + tests unitaires) |

### Intégration Continue (CI)
Workflow GitHub (`.github/workflows/ci.yml`):
- Build TypeScript
- Démarre l'API en arrière-plan
- Lance `verify:all` avec flags durs (`VERIFY_ALL_HARD_REPLAY=1`, `VERIFY_ALL_HARD_DETERMINISM=1`, `AUDIT_VERIFY_ON_APPEND=1`, `AUDIT_REFUSE_STALE=1`)
- Exécute les tests vitest (déterminisme + hash canonique)
Artifacts: `server-ci.log`, `audit.log` migré, hash final.
| `verify:hyperindex` | Re-sérialise et compare `featureHash` HyperIndex |
| `build:proof-pack` | Construit le bundle export (portable) |
| `verify:proof-pack` | Reconstruit le pré-image canonical et compare `packKeccak256` |
| `verify:guardrails` | Évalue guardrails v2 (blocked / warnings) |

## Feature Hashing (v1 & v2)
`featureHash` = keccak256(serialisation canonique incluant `ts=`). Pour reproduction stricte sans variance temporelle, `featureHashV2` exclut les lignes volatiles (ou normalise l’ordre) et est recalculée côté vérification.

Canonical serialization (extrait simplifié):
```
v=<schemaVersion>
asOfTs=<epoch_ms>
window:15m:count=...
window:1h:... (etc)
m:allocationDeviation=<value>
m:executionsLast24h=<value>
... (metrics triées)
```
Hash = keccak256(Buffer UTF-8 join `\n`).

`featureHashV2` supprime/neutralise toute ligne sujette à divergence temporelle pour que le *Proof Pack strict snapshot* puisse être vérifié indépendamment de l’horodatage local.

## Auto-Anchoring Scheduler
Endpoints:
```
POST /api/strategy/auto-anchor/start { "intervalSec": 600 }
POST /api/strategy/auto-anchor/stop
```
Quand actif: à chaque intervalle → requête `GET /api/strategy/proof-pack/latest?anchor=1` produisant un enregistrement dans `data/anchors.log` (packKeccak256 + rollingHash + timestamp + anchorRef). Permet de démontrer la non-réécriture temporelle en montrant une séquence d’ancres espacées.

## Anchoring (Off-chain Lightweight)
| `GET /api/hyperindex/features/head` | Alias de `/api/strategy/features/head` (snapshot + featureHash) |
| `GET /api/hyperindex/events?limit=100&sinceTs=...&types=swap,transfer` | Liste événements ingérés filtrables |
Extension étendue des guardrails pour inclure détection proactive et intégrité des features.
| `GET /api/hyperindex/_meta` | Métadonnées locales (eventsProcessed, firstEventTs, lastEventTs, chainIds, counts par type) |
| `GET /api/hyperindex/routes` | Sous-ensemble de routes de découverte utile |
Règles existantes (blocking):

Exemples (curl):
Nouvelles analyses (v2):
```bash
curl -s http://127.0.0.1:8787/api/hyperindex/_meta | jq
Nouveaux champs sur `ai_decision`:
curl -s http://127.0.0.1:8787/api/hyperindex/features/head | jq
curl -s 'http://127.0.0.1:8787/api/hyperindex/events?limit=5&types=swap' | jq
Config (merge avec defaults) : `config/guardrails.json`
```

Champs config additionnels pris en charge dans code (exemple courant – voir fichier réel pour mises à jour):
```jsonc
{
	"maxVolatilityDrift": 0.35,
	"maxFeatureAgeMs": 300000,
	"hashMismatchHardBlock": true
}
```

UI Dashboard: panneau “Guardrails” affiche status (BLOCKED/clear), warnings, dérive de volatilité, âge des features, mismatchs.
### Vérification CLI (featureHash)
Script: `npm run verify:hyperindex`

Comportement:
- Récupère `/api/hyperindex/features/head`
- Re-sérialise avec `serializeFeatures()`
- Re-calcul keccak256
- Sortie 0 si match, 1 si mismatch, 2 si erreur endpoint

### Test Automatisé
`tests/hyperindexFeatureHash.test.ts` ajoute un test qui injecte 3 événements synthétiques et confirme que le hash local = hash serveur.

### UI Panneau HyperIndex
Dans le dashboard (`AiDashboard`):
- Affiche `featureHash` (troncation), nombre d'évènements, top metrics.
- Bouton “Re-hash local” utilisant `js-sha3` pour vérifier côté navigateur.
- Rafraîchissement manuel (pas de polling continu pour réduire le bruit).

### Roadmap Phase 2
- Multichain pseudo unordered: inclusion `chainId` plus adaptateurs SourceAdapter
- Aggregations indexing-time additionnelles (ex: top volatility windows)
- Filtrage par delegator pour features privées chiffrées (si nécessaire)
- Intégration Open Gradient (évaluation model externe)
- Tests e2e Proof Pack + ancrage périodique automatisé

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


