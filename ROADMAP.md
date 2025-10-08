# Autonomous Trading Wallet – Roadmap & TODO

_Last updated: 2025-10-07_

---
## 1. Objectif Global
Construire un wallet autonome qui :
- Décide quand acheter / vendre / ne rien faire (BUY / SELL / SKIP) pour un ou plusieurs actifs.
- Applique des limites (guardrails) transparentes et vérifiables.
- Exécute via délégation (EOA → Smart Account) sans API fermée externe.
- Journalise chaque décision et action dans une chaîne d’audit inviolable (hash chaîné).
- Permet de **rejouer** une décision passée (reproductibilité = preuve d’intégrité).
- Permet de prouver quel modèle + quelles features ont été utilisées (modelHash + featureHash).
- A une composante de DCA en place, séparée de l'architecture IA

---
## 2. Principes Clés ("Garde-fous conceptuels")
| Principe | Description |
|----------|-------------|
| Pas d’API fermée | Aucune dépendance à OpenAI / SaaS pour la logique cœur. |
| Reproductible | Même features + même modèle = même décision. |
| Audit fort | Chaque ligne contient liens d'intégrité (prevEntryHash, rollingHash). |
| Transparence | Hash des features + hash du modèle inclus dans `ai_decision`. |
| Séparation des rôles | Décider ≠ Exécuter ≠ Auditer (couches distinctes). |
| Extensible | Moteur peut évoluer (v2, v3) sans casser les anciennes décisions (versioning). |

---
## 3. État Actuel (Résumé)
| Domaine | Statut |
|---------|--------|
| Journal d’audit chaîné (strict) | ✅ opérationnel + migration legacy → strict vérifiée |
| Rolling integrity (prevEntryHash + rollingHash) | ✅ stable |
| HyperIndex (features multi fenêtres 15m/1h/6h/24h) | ✅ ingestion + hashing déterministe |
| featureHash v1 / featureHashV2 (timestamp-agnostic) | ✅ implémentés + test vérif |
| modèle versionné (modelHash) | ✅ hash canonique du snapshot modèle actuel |
| aiRationaleHash | ✅ traçabilité explicative |
| Décision preview | ✅ déterministe (structure actionType / rationale / hashes) |
| Exécution + guardrails | ✅ blocage ou envoi, journalisé |
| Guardrails v2 (drift, stale, hash mismatch) | ✅ étendus + hard block option |
| Guardrails config JSON (reload) | ✅ endpoints reload/inspect |
| Métriques (effectiveness) | ✅ décisions / exécutions / blocages |
| decisionRollingHash | ✅ présent partout (chaînage preuves) |
| Replay / vérification décision (API + CLI) | ✅ comparaison champs critiques |
| Proof Pack (export portable vérifiable) | ✅ canonical hashing 2‑phases + CLI verify |
| Anchoring off-chain (manual + auto) | ✅ anchors.log + scheduler auto-anchoring |
| Suite CLI vérification (audit, replay, hyperindex, pack, guardrails) | ✅ disponible |
| UI dashboard | ✅ panels décisions / guardrails / HyperIndex / Proof Pack |
| Flux audit live (SSE) | ✅ streaming temps réel |
| Tests fondamentaux | ✅ audit chain / déterminisme / hyperindex / guardrails |
| Documentation (roadmap + features) | 🟡 partielle – consolidation architecturale à faire |
| Moteur trade avancé (BUY/SELL sizing dynamique) | 🟡 basique; optimisation & multi-modèle à venir |
| Multi-modèle registry | ❌ (à concevoir) |
| Source multi-chain (SourceAdapter) | ❌ (squelette à ajouter) |
| Momentum & ratios avancés features | ❌ (placeholders restants) |
| On-chain anchoring (L2 / calldata) | ❌ futur (actuel = off-chain fichier) |
| Diagrammes / narration de confiance | ❌ à écrire |

---
## 4. TODO Liste (Catégories)
### A. Intelligence / Décision
1. (M1) Étendre la structure de décision : `targetAsset`, `side`, `sizePct`.
2. (M3) Moteur déterministe v1 : logistic / scoring simple -> action + risk + confidence.
3. (M3) `strategy-model.json` + `modelHash` (hash JSON canonique).
4. (Future) Multi-actif : sélection du meilleur candidat (score max).

### B. Features & Données
5. (M2) Générer features de base :
   - `balanceStableRatio`
   - `balanceTargetRatio`
   - `allocationDeviation`
   - `timeSinceLastTradeMins`
   - `volatilitySimple`
   - `momentumShortMinusLong`
6. (M2) Calculer `featureHash` (ordre stable, JSON canonique -> keccak256).
7. (Future) Brancher prix réels ou source on-chain partielle.

### C. Exécution & Guardrails
8. (M1 extension) Ajouter body `{ delegator, decisionRollingHash? }` à `/api/strategy/execute`.
9. (M4) Ajouter `guardrailReason` (ex: `risk_score_exceeds_max`, `min_spacing_not_elapsed`).
10. (Future) Ajustement dynamique des tailles (risk envelope).

### D. Rejouabilité / Vérification
11. (M4) Endpoint `/api/strategy/replay/:rollingHash` :
    - Recharge décision
    - Recompose features
    - Recalcule décision moteur v1
    - Compare (action, sizePct, riskScore, confidence, modelHash, featureHash, aiRationaleHash)
    - Retourne `match: true/false`.
12. (Future) Script CLI `npm run strategy:replay -- --rollingHash <h>`.

### E. UI / Expérience
13. (M5) Dashboard web :
    - Carte “Dernière décision”
    - Carte “Dernière exécution”
    - Panel guardrails + usage 24h
    - Boutons: Preview / Execute / Replay
14. (M6) Audit live (SSE `/api/strategy/audit/live` ou long-poll).
15. (M6) Page modèle : afficher `modelHash` + téléchargement.
16. (Future) Indicateurs visuels de blocage / réussite.

### F. Gouvernance Modèle
17. (M6) Registry simple : `models/` + alias `current`.
18. (Future) Endpoint `POST /api/strategy/model/switch` (audit `model_switch`).
19. (Future) Pack “proof bundle” export (decision + feature vector + model snapshot).

### G. Tests / Robustesse
20. (M7) Test audit chain (re-hash complet).
21. (M7) Test déterminisme (même inputs => même outputs).
22. (M7) Test guardrails (cas risk, quota, spacing). 
23. (Future) Load test simple (latence preview/execute).

### H. Documentation / Clarté
24. (M7) `PROJECT_GOALS.md` (No closed AI / Principes).
25. (M7) Section README “Rejouer une décision”.
26. (Future) Diagrammes (flux décision → exécution → audit).

---
## 5. Milestones (Ordre Recommandé)
| Milestone | Contenu | Objectif obtenu |
|-----------|---------|-----------------|
| M1 | Décision trade structure + execute body (delegator) | Plus qu’un stub DCA, structure future prête |
| M2 | Features + featureHash | Base mesurable + reproductibilité partielle |
| M3 | Modèle déterministe + modelHash | Proof of deterministic AI |
| M4 | Replay + guardrailReason | Preuve d’intégrité + clarté blocages |
| M5 | UI dashboard minimal | Lisibilité / démonstration live |
| M6 | Audit live + registry modèle | Sensation “autonome”, extensible |
| M7 | Tests + docs finalisées | Prêt pour handoff sérieux |

---
## 6. Format Décision (Proposé v1)
```jsonc
{
  "targetAsset": "WMON",
  "side": "BUY",      // BUY | SELL | SKIP
  "sizePct": 0.15,      // fraction du capital utilisable
  "riskScore": 34,      // 0–100
  "confidence": 0.71,   // 0–1
  "rationale": "Rééquilibrage sous-exposition WMON",
  "modelHash": "0x...",
  "featureHash": "0x...",
  "featuresSchemaVersion": 1
}
```

Feature vector ordonné (ex):
```ts
[
  balanceStableRatio,
  balanceTargetRatio,
  allocationDeviation,
  timeSinceLastTradeMins,
  volatilitySimple,
  momentumShortMinusLong
]
```
`featureHash = keccak256(JSON.stringify({ v:1, features }))`

---
## 7. Replay – Logique
1. Récupère la ligne audit `ai_decision` ciblée.
2. Recompose ou recharge les features (doivent être déterministes ou archivées).
3. Charge le modèle (`strategy-model.json`).
4. Recalcule décision locale.
5. Compare champs critiques.
6. Résultat: `match: true|false`, sinon détail des divergences.

---
## 8. GuardrailReason (Liste initiale)
- `risk_score_exceeds_max`
- `confidence_below_min`
- `max_exec_24h_reached`
- `daily_cap_reached`
- `min_spacing_not_elapsed`
- (Future) `position_size_limit`
- (Future) `volatility_too_high`

---
## 9. Endpoints Nouveaux (Prévision)
| Endpoint | Méthode | Objet |
|----------|---------|-------|
| `/api/strategy/preview` | GET | Génère décision (moteur v1 quand prêt) |
| `/api/strategy/execute` | POST | Execute dernière ou spécifique `{ delegator, decisionRollingHash? }` |
| `/api/strategy/replay/:rollingHash` | GET | Vérifie une décision |
| `/api/strategy/guardrails` | GET | Guardrails courants |
| `/api/strategy/guardrails/reload` | POST | Rechargement |
| `/api/strategy/effectiveness` | GET | Métriques agrégées |
| `/api/strategy/audit/stream` | GET | Paging audit (existant) |
| `/api/strategy/audit/live` | GET (SSE) | Flux temps réel (à venir) |
| `/api/strategy/model` | GET | Infos modèle courant (à venir) |

---
## 10. Prochaines Actions Immediates (si validées)
1. Implémenter champs décision trade (M1).
2. Ajouter body `delegator` & param `decisionRollingHash` à execute.
3. Construire feature builder + hash (M2).
4. Ajouter modèle simple + modelHash (M3).

---
## 11. Items Différés / Idées Futures
- On-chain anchoring périodique (`finalRollingHash` + packKeccak256) – off-chain déjà fait.
- Multi-actifs prioritisation (scores comparés).
- Simulation sandbox (dry-run non auditée).
- Backtest mode (rejouer historique synthétique).

---
## 12. Glossaire Rapide
| Terme | Sens |
|-------|------|
| featureHash | Empreinte des inputs (features) d’une décision |
| modelHash | Empreinte JSON canonique du modèle utilisé |
| replay | Recalcul local d’une décision passée |
| guardrail | Règle qui bloque ou non une exécution |
| rollingHash | Hash cumulatif d’intégrité du journal |

---
## 13. Statut Synthétique (Barre de progression)
```
[█████████--]  ~78% fondations (intégrité / preuve / replay / export / guardrails v2 livrés)
```

---
## 14. Engagements Non-Négociables
- Pas d’API d’IA fermée.
- Toute décision est vérifiable.
- Chacune peut être reliée aux données d’entrée et au modèle.

---
_Quand ce fichier diverge de la réalité: le mettre à jour immédiatement après chaque milestone._

---
## 15. Évidence & Export (Nouveautés)
Composants de preuve et de traçabilité livrés :

1. Chaîne d’audit stricte: recalcul complet post‑migration, plus de “gaps” legacy.
2. HyperIndex: fenêtres multiples dérivées de l’event store + hashing déterministe.
3. Canonical Proof Pack: bundle (décision, features sérialisées, slice événements, rolling, manifest) → hash en 2 phases (exclusion packKeccak256 & anchorRef) pour éviter auto‑référence.
4. Anchoring off-chain: `anchors.log` (rollingHash + packKeccak256 + timestamp + anchorRef optionnel) + mode `?anchor=1` + scheduler auto.
5. Guardrails v2 enrichis: détection drift volatilité, stale features, mismatch featureHash; mode blocage dur configurable.
6. CLI Vérification: audit chain, hyperindex, replay décision, guardrails, proof pack (reconstruction canonical hashing), latest integrity.
7. UI Proof Pack Panel: téléchargement, décompression, re-hash canonical, liste des anchors, contrôle humain rapide.

Prochain focus “évidence” :
- On-chain anchoring (L2 / calldata minimal) pour horodatage tiers.
- Squelette SourceAdapter multi-chaîne (préparation extension données). 
- Consolidation documentation “Architecture de Confiance” (diagrammes, flux hashing, invariants).
