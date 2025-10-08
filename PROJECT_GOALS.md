# Project Goals: Verifiable Autonomous DCA Agent

## 1. Vision
Construire un agent DCA autonome dont chaque décision est:
- Traçable (audit append-only + rollingHash)
- Reproductible (features + modèle déterministe + replay strict)
- Vérifiable par n'importe qui (endpoints + scripts + hashes documentés)
- Extensible vers une preuve externe (ancrage on-chain futur)

## 2. Principes Clés
| Principe | Description | Concrétisation |
|----------|-------------|----------------|
| Pas de "boîte noire" | Pas de modèle fermé non vérifiable | `strategy-model.json` hashé + versionné |
| Determinisme | Même entrée => même décision | Dual hashing `featureHash` / `featureHashV2` + `strict-snapshot` |
| Audit append-only | Immuabilité pratique | `prevEntryHash` + `rollingHash` chain |
| Rejouabilité | Recalcul indépendant | Script & endpoint `/api/strategy/decision/replay` |
| Transparence features | Canonicalisation stable | `featuresCanonical` persisté dans audit |
| Observabilité live | Visualisation immédiate | SSE `/api/audit/stream` + Dashboard |
| Sécurité d'action | Prévention d'abus | Guardrails (freq, risk, daily cap) + raisons |
| Futur ancrage | Preuve externe | Stub `/api/audit/anchor` (à venir) |

## 3. Pipeline Décision → Preuve
```
[Features Collect] --> [Canonical Snapshot] --keccak--> featureHash
                                    | (strip ts)
                                    +--keccak--> featureHashV2
       ↓
[Deterministic Model] --score+z--> [Mapping] --> actionType, riskScore, confidence
       ↓                                            ↓
  modelHash, weightsUsedHash                  aiRationaleHash (hash)
       ↓                                            ↓
      (All packaged & appended) --> audit.log line (with prevEntryHash + rollingHash)
```

## 4. Hashes & Signification
| Champ | Rôle | Détails |
|-------|------|---------|
| `prevEntryHash` | Intégrité locale maillon | keccak(JSON brut ligne précédente) |
| `rollingHash` | Chaîne cumulative | keccak(précédentRollingHash || lineHash) |
| `featureHash` | Empreinte features complètes | Inclut éventuelle ligne `ts=` |
| `featureHashV2` | Hash strict stable | Exclut toute ligne commençant par `ts=` |
| `aiRationaleHash` | Justification anonymisée | Hash du texte ou blob rationale |
| `modelHash` | Identité du modèle | Hash canonical de `strategy-model.json` (champ métas trié) |
| `weightsUsedHash` | Empreinte des poids | Hash du JSON trié des poids utilisés |
| `mappingVersion` | Version mapping score -> action | Permet de détecter un changement sémantique |
| `rawScore` / `logitZ` | Trace numérique brute | Utile pour reproduction fine |

## 5. Rejouabilité Modes
| Mode | Condition | Vérifie |
|------|-----------|---------|
| `basic` | Vérif rapide | actionType, riskScore, confidence, modelHash, featureHash |
| `strict` | + provenance avancée | + featureHashV2, rawScore presence, mappingVersion, weightsUsedHash |
| `strict-snapshot` | Hashs invariants hors temps | Ré-hash `featuresCanonical` (v1 & v2) + présence provenance |

## 6. Endpoints Clés
| Endpoint | Usage |
|----------|-------|
| `GET /api/strategy/preview` | Pré-visualiser prochaine décision + provenance |
| `GET /api/strategy/decision/latest` | Dernière décision + vérification inline |
| `GET /api/strategy/decision/replay` | Rejouer (modes basic/strict/strict-snapshot) |
| `GET /api/audit/stream` | SSE audit live |
| `GET /api/strategy/history` | Pagination des décisions |
| `GET /api/strategy/effectiveness` | Stats, guardrails, derniers états |
| `GET /api/_routes` | Découverte runtime |
| `POST /api/strategy/execute` | Orchestration exécution DCA |

## 7. Scripts CLI
| Script | Commande | Description |
|--------|----------|------------|
| Vérifier audit chain | `npm run verify:audit` | Ré-hash et contrôle intégrité chain |
| Vérifier dernière décision | `npm run verify:latest` | Re-hash features + provenance presence |
| Rejouer décision | `npm run replay:decision` | Dernière ou `--rolling` ciblé |

## 8. Guardrails Implémentés

## 9. Observabilité

## 10. Intégration HyperIndex (Phase 1)
Objectif: Aligner l'agent sur la sémantique HyperIndex pour démontrer ingestion structurée + features hashées reproductibles.

Correspondances (Spec ➜ Impl locale):
- config.yaml ➜ Pas nécessaire (prototype mono-process) ; équivalent implicite dans `server.ts` + schéma d’événements TS.
- schema.graphql ➜ `src/hyperindex/schema.ts` (interfaces `IngestedEvent`, `FeatureSet`).
- Event handlers ➜ Endpoint `POST /api/strategy/events/ingest` (validation légère + append JSONL). Pas de transformation complexe encore.
- Storage (Hasura / DB) ➜ Fichier append-only `data/hyperindex/events.log`.
- Feature windows ➜ `computeFeatureSet()` dans `src/hyperindex/features.ts` (15m/1h/6h/24h).
- featureHash ➜ `serializeFeatures()` ordonné + keccak256 (champ `featureHash`).
- _meta query ➜ `GET /api/hyperindex/_meta` (eventsProcessed, first/last ts, chainIds, counts par type).
- events query ➜ `GET /api/hyperindex/events?limit&sinceTs&types` (reverse tail, ordre chronologique en sortie).
- features head ➜ `GET /api/hyperindex/features/head` (alias de `/api/strategy/features/head`).
- routes ➜ `GET /api/hyperindex/routes` (filtre des endpoints pertinents).

Schéma hashing features (Phase 1):
```
lines = [
     `schemaVersion=${schemaVersion}`,
     `asOfTs=${asOfTs}`,
     ...windowSpecs.map(w => `window:${w.label}:${w.fromTs}:${w.toTs}`),
     ...Object.keys(metrics).sort().map(k => `m:${k}=${metrics[k] ?? 'null'}`)
]
featureHash = keccak256( utf8(lines.join('\n')) )
```

Stratégie d’évolution (Phase 2+):
1. Ajouter `dimension` multichain (namespacing des IDs + unordered mode logique).
2. Séparer `featureHash` et `featureHashDeterministic` si l’on introduit des métriques volatiles (ex: latence head) — OU filtrer ces métriques de la sérialisation.
3. Introduire `schemaVersion` incrémental et section `meta:` optionnelle (non hashée) pour diagnostic.
4. Passer ingestion vers pipeline asynchrone (queue) => handlers calculant agrégats à l’écriture (pattern indexing-time aggregation HyperIndex).
5. Ajouter support d’ancrage `_meta.progressBlock` en liant un provider HyperSync / RPC (emuler block head local pour cohérence).

Critères de succès Phase 1:
- Rehash côté client = identical (`verify:hyperindex` script à venir).
- Diff clair si un seul metric modifié (ligne `m:key=value`).
- _meta stable après burst ingestion (<50ms sur 1k events locaux).

Prochaines Actions (résumé): UI panneau HyperIndex (metrics + hash + bouton rehash), test automatisé de recomputation, script CLI, documentation README.


## 10. Roadmap Immédiate
- Endpoint ancrage stub (JSONL anchors)
- Export snapshot (featuresCanonical + décision → téléchargeable)
- Diagrammes README + amélioration docs
- Option on-chain réelle (contrat / data availability)

## 11. Menaces & Mitigations
| Menace | Risque | Mitigation |
|--------|--------|------------|
| Édition manuelle audit.log | Cassure de chain | rollingHash / prevEntryHash mismatch détectable |
| Changement modèle silencieux | Décision divergente | `modelHash` + tests replay strict |
| Dérive features temporelles | Non reproductible | `featureHashV2` (sans ts) + snapshot canonical |
| Suppression lignes anciennes | Perte chain continuity | rollingHash recalcul => mismatch |

## 12. Extension Futur
- Ancrage sur L2 / calldata périodique (rollingHash récent)
- Merkle batch lines → preuve compacte
- Indexation externe (HyperIndex / Envio) pour requêtes analytiques
- Ajout de signatures cryptographiques sur segments de log

---
**TL;DR:** Chaque décision = paquet (features + modèle + mapping) hashé, chainé, rejouable; aucune confiance aveugle requise.
