# Inference & Oracles – Mémo Persistant

_Objectif: éviter toute dérive d'alignement sur l'intégration Open Gradient (Swarm Inference) et Switchboard Oracle._

## 1. Intent Stratégique
- **Open Gradient (OG)**: Fournir l'inférence principale des décisions de trading via un réseau ouvert / swarm afin d'obtenir diversité, résilience, et (potentiellement) preuve cryptographique / traçabilité des modèles.
- **Switchboard Oracle**: Source de vérité des prix spot on-chain (ou quasi on-chain) pour alimenter les features temps réel et réduire la dépendance à des prix synthétiques internes.
- **HyperIndex**: Agrégateur d'événements internes (transferts, exécutions, métriques dérivées) complémentaire aux données exogènes de marché (prix, volatilité intra-bloc, etc.).

## 2. Complémentarité
| Composant | Rôle | Apporte |
|-----------|------|---------|
| HyperIndex | Historique agrégé interne multi-fenêtres | Cohérence, dérivation de features comportementales |
| Switchboard | Prix spot + éventuellement volatilité / TWAP | Ancrage marché externe, qualité des features prix |
| Open Gradient | Inférence de la décision (score, action) | Intelligence distribuée, potentielle vérifiabilité |

## 3. Invariants à Préserver
1. Reproductibilité locale d'une décision passée = hash(blob_inférence) + featureHash + modelHash OG conservés.
2. Aucune dépendance à un service fermé: OG + Switchboard = open infra / permissionless (ou chemin clair vers open).
3. Chaque ligne `ai_decision` contient: `featureHash`, `modelHash`, **`inferenceProofHash`** (à ajouter), `inferenceProvider`.
4. Proof Pack inclura `inference.json` (canonical blob) dans la v2.
5. Fallback déterministe local autorisé uniquement si OG indisponible (audit: `inferenceProvider: fallback-local`).

## 4. Canonical Inference Blob (Draft)
```jsonc
{
  "schemaVersion": 1,
  "provider": "open-gradient",
  "model": { "id": "og:swarm/modelX", "version": "2025-10-08", "weightsCommit": "sha256:..." },
  "input": { "featureSchemaVersion": 1, "featureHash": "0x..", "featuresUsed": { /* subset */ } },
  "output": { "raw": { "logits": [0.12,-1.4,0.91], "score": 0.7312 }, "mapped": { "actionType": "BUY", "sizePct": 0.17, "riskScore": 34, "confidence": 0.73 } },
  "swarm": { "jobId": "abc123", "peers": 7, "elapsedMs": 184, "consensus": "quorum-majority" },
  "timestamp": 1696799999123
}
```
`inferenceProofHash = keccak256(JSON.stringify(blobCanonicalSorted))`.

## 5. Roadmap d'Intégration (Résumé)
1. Provider abstraction (`InferenceProvider`), extraction moteur local en fallback.
2. Stub OG adapter (process spawn Python) → hash blob.
3. Champs audit supplémentaires + test unitaire re-hash blob.
4. Proof Pack v2 (ajout inference.json + manifestVersion bump).
5. Replay strict (re-hash blob) + script CLI.
6. Passage du stub à l'SDK OG réel (jobId, peers, signatures si dispo).
7. Ajout prix Switchboard dans features (balanceTargetRatio, volatilitySimple recalculée, momentum). Hash stable.

## 6. Données Switchboard – Intégration
- Endpoint / adaptateur: `getSpot(symbol)` → { price, conf, slot? }
- Cache TTL court (ex: 3–5s) pour éviter spam.
- Normaliser: arrondi 8 décimales avant dérivation features.
- Introduire champ `dataProvenanceHash` (future) si multi-sources.

## 7. Variables d'Environnement Clés (à introduire)
| Variable | Effet |
|----------|-------|
| `INFERENCE_PROVIDER=open-gradient|local` | Sélection dynamique provider inferences |
| `OG_PYTHON_PATH` | Pointage script / venv OG |
| `OG_INFERENCE_TIMEOUT_MS` | Timeout appel OG (fallback si dépassé) |
| `ENABLE_SWITCHBOARD=1` | Active collecte prix réel |
| `SWITCHBOARD_ENDPOINT` | RPC / relayer |
| `SWITCHBOARD_API_KEY` | Clé API Surge (Switchboard) |
| `SWITCHBOARD_SYMBOLS` | Liste de paires ex: `WMON/USD,BTC/USD` |
| `SWITCHBOARD_STALE_MS` | Durée ms avant qu'un prix soit considéré périmé (def 15000) |
| `PRICE_BASE_SYMBOL` | Actif de référence pour features prix (ex: `MON` ou `WMON`) |

## 8. Tests Critiques à Ajouter
- `inferenceBlobHash.test.ts`: générer blob OG stub → recalcul hash = match.
- `replayDecisionOG.test.ts`: lire ligne audit + blob → re-hash stable.
- `fallbackLocalIfTimeout.test.ts`: simuler timeout OG → provider fallback + flag audit.
- `switchboardPriceFeature.test.ts`: injection prix stable = featureHash stable multi-run.

## 9. Risques & Mitigations
| Risque | Impact | Mitigation |
|--------|--------|-----------|
| Non-déterminisme OG | Replay impossible | Mode deterministic + blob cache hashé |
| Latence OG élevée | Temps réponse API | Timeout + fallback + métrique latence |
| Changement modèle OG silent | Divergence décision | Stocker `model.version` + `weightsCommit` + rejeter si mismatch sur replay strict |
| Variations prix multi-sources | Instabilité featureHash | Normaliser + freeze asOfTs + arrondi |

## 10. Check-list Avant Fusion OG
- [ ] Interface provider mergée
- [ ] Champ `inferenceProofHash` dans audit
- [ ] Test re-hash OK
- [ ] FeatureHash stable (multi-run) avec Switchboard activé
- [ ] Documentation (ce fichier + section roadmap mise à jour)

## 11. Surge (Switchboard) Implémentation Actuelle (Snapshot)
- Adapter: `SwitchboardSurgeAdapter` (`src/oracles/switchboard.ts`).
- Initialisation auto si `ENABLE_SWITCHBOARD=1` + `SWITCHBOARD_API_KEY`.
- Normalisation prix: arrondi 8 décimales, cache in-memory, stale cutoff configurable.
- Fallback: oscillateur synthétique si prix indisponible ou stale.
- Intégration features: via `getSpot('WMON')` dans `computeCoreFeatures` (ne modifie pas encore le `featureHash` existant).


---
_Mettre à jour ce mémo à chaque fois qu'un point de la section 5 est livré._
