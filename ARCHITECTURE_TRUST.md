# Architecture de Confiance – DCA Autonomous Wallet

Ce document détaille les invariants cryptographiques et la chaîne de vérification permettant de prouver qu’une décision AI n’est ni falsifiée ni opaque.

## 1. Piliers
| Pilier | Description | Preuve |
|--------|-------------|--------|
| Chaîne d’audit stricte | `prevEntryHash` + `rollingHash` sur chaque ligne | `npm run verify:audit` |
| Hash features déterministe | Sérialisation canonique multi-fenêtres → `featureHash` / `featureHashV2` | `npm run verify:hyperindex` |
| Hash modèle & poids | Snapshot JSON & liste triée → `modelHash`, `weightsUsedHash` | `replay:decision` strict |
| Rationale immuable | Texte → `aiRationaleHash` (pas besoin de stocker en clair) | `verify:latest` / replay |
| Rejouabilité modes | basic / strict / strict-snapshot | endpoint `/api/strategy/decision/replay` |
| Proof Pack portable | Bundle + hash canonical 2 phases (`packKeccak256`) | `verify:proof-pack` |
| Anchoring off-chain | `anchors.log` séquence temporelle (rolling + pack) | inspection + future on-chain |
| Guardrails v2 | Drift, stale, hash mismatch, risk/caps | `verify:guardrails` |
| Hash config guardrails | SHA-256 JSON trié → audit `guardrails_config` | `verify:guardrails-config` |
| Orchestration globale | Exécute tous les checks principaux | `verify:all` |

## 2. Sérialisation des Features
Format lignes (ex simplifié):
```
v=<schemaVersion>
asOfTs=<epoch_ms>
window:15m:...metrics...
window:1h:...metrics...
m:allocationDeviation=...
m:volatilitySimple=...
...
```
Hash: `featureHash = keccak256(join('\n'))`. Variante stable: `featureHashV2` → exclut/normalise composantes temporelles pour snapshot strict.

## 3. Audit Chain
`prevEntryHash = keccak256(JSON(line_{n-1}))`
`rollingHash = keccak256(rollingHash_{n-1} || keccak256(JSON(line_n)))`
Invariants:
- Toute mutation retro-active brise la vérification stricte.
- Preuve de complétude: nombre de lignes + `finalRollingHash` exposé + ancrages périodiques.

## 4. Replay Modes
| Mode | Vérifications |
|------|---------------|
| basic | Action & champs principaux présents |
| strict | Re-calcul features → `featureHash` égal + modèle égal |
| strict-snapshot | Reconstruit sérialisation canonical → comparaison `featureHashV2` & invariants (rationale, modèle, scores) |

## 5. Proof Pack – Canonicalisation
Étapes:
1. Construire `manifestProvisional` sans `packKeccak256` ni `anchorRef`.
2. Assembler `{ files:[...], manifest: manifestProvisional }` → JSON stable → keccak256 = `packKeccak256`.
3. Émettre `manifestFinal = manifestProvisional + packKeccak256 (+ anchorRef optionnel)`.
4. Le bundle final inclut le manifest final mais son hash racine reste celui du pré‑image (non auto-référentiel).

Vérification CLI reconstruit (1) puis compare.

## 6. Anchoring
Actuel: Off-chain (`anchors.log`)
Entrée: `{ ts, anchorRef, packKeccak256, rollingHash, rollingHashHeight, featureHash, decisionRollingHash }`.
Futur: On-chain calldata minimal périodique (L2 bon marché) → preuve tierce temporelle.

## 7. Guardrails v2
Combinaisons blocking / warning:
- `risk_score_exceeds_max`, `confidence_below_min`, `min_spacing_not_elapsed`, `daily_cap_reached`, `max_exec_24h_reached`.
- Warnings analytiques: `volatility_drift_exceeds_threshold`, `features_stale`.
- Integrity: `feature_hash_mismatch`, `feature_hash_v2_mismatch` (peuvent devenir hard block si flag).

## 8. Invariants Résumés
| Invariant | Rupture détectée par |
|-----------|----------------------|
| Mutation audit ligne n | verify:audit (mismatch) |
| Divergence features recalculées | replay strict / verify:hyperindex |
| Rationale altérée | replay / verify:latest (aiRationaleHash mismatch) |
| Modèle modifié rétroactivement | replay strict (modelHash mismatch) |
| Pack falsifié | verify:proof-pack (hash mismatch) |
| Réécriture après ancrage | Séquence anchors inconsistent / future on-chain diff |

## 9. Processus de Vérification Rapide (Human Checklist)
1. `npm run verify:audit` → PASS
2. `npm run verify:latest` → PASS
3. `npm run verify:hyperindex` → PASS
4. `npm run build:proof-pack && npm run verify:proof-pack -- dist/last-pack.json.gz` → OK
5. Inspect `data/anchors.log` dates espacées + dernière ligne `rollingHash` = audit head
6. `npm run verify:guardrails-config` → PASS (pas de modification silencieuse)
7. Option: `npm run verify:all` (agrégé)

## 10. Extension Prochaine
- SourceAdapter multi-chaîne (déjà squelette) pour intégrer prix réels & nouveaux events.
- On-chain anchoring.
- Enrichissement features (momentum, ratios cross-asset).
- Multi-model registry avec versioning explicite.

---
Document vivant — mettre à jour à chaque ajout d’un nouveau mécanisme de preuve ou guardrail.
