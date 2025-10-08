# FEATURES & STRATEGY DESIGN

_Dernière mise à jour: 2025-10-08_

> Intégrité (08-10-2025): Chaîne d'audit réparée (divergence initiale ligne 107). Nouveau `finalRollingHash` = `0x03155ab85a4d698d1331a0a1d1765031fd84d812354f7d5aa92cfc8f2996ef5b`. Activer la vérification post-append: `AUDIT_VERIFY_ON_APPEND=1`.

## Status Snapshot (2025-10-08)
| Item | Description | Status | Notes |
|------|-------------|--------|-------|
| Audit Chain (rollingHash) | Cryptographic append-only chain with prevEntryHash + rollingHash | ✅ | Verified via `npm run verify:audit` & included in `verify:all`. Snapshot `finalRollingHash.json` in place. |
| Feature Hash v1/v2 | Dual canonical serialization (v2 excludes ts) | ✅ | Eliminated historical mismatch; both hashes emitted for backward compatibility. |
| Model Hash | Canonical model file hashing (weights + meta) | ✅ | Stable across replays; part of ai_decision meta. |
| Replay Tooling | CLI replay (list/chain/strict/strict-snapshot) + soft step in verify-all | ✅ | Last 3 decisions reproducible (risk=4 conf=0.9049 SKIP). Hard-fail mode pending. |
| Guardrails v2 | Evaluation + reason + diff UI | ✅ | Diff panel live; reasons logged on blocks. |
| Live vs Stream Divergence | Real-time rolling hash badge | ✅ | Badge shows live parity; alerts on drift. |
| Proof Pack Build/Verify | Two-phase manifest + packKeccak256 | ✅ | `build:proof-pack` & `verify:proof-pack` passing. |
| Proof Pack Debug Endpoint | `/api/proof-pack/debug` exposes pre-image | ✅ | Ready for advanced UI; shows provisional manifest + pack hash. |
| Force Decision Endpoint/CLI | `/api/strategy/decision/force` + script | ✅ | Used to refresh decision & align feature hash state when needed. |
| Audit Lock & Buffer | Lock file + buffered writes + snapshot final hash | ✅ | Prevents race during migrations; unlock endpoint included. |
| Guardrails Reason Field | Structured reason in blocked decisions | ✅ | Present; ensures transparency. |
| UI Hash & Replay Panels | Hashes, Guardrails diff, HyperIndex, Replay | ✅ | Core transparency dashboard operational. |
| Advanced Proof Pack UI Panel | Rich visualization of debug endpoint data | ✅ | Debug panel live (pre-image preview + copy hash/manifest). Further UX polish possible. |
| Replay Hard Mode Enforcement | Fail pipeline on mismatch automatically | 🧪 | `VERIFY_ALL_HARD_REPLAY=1` promeut l'étape (sinon soft). |
| Oracle Integration (Switchboard) | External price feed + safe fallback | ⏳ | Design documented (Section 8); not implemented. |
| Revocation Service | Auto revoke (abnormal HyperIndex streak) + status endpoint | ✅ | Implémenté (Section 9). |
| Donation Layer | Automated social impact transactions | ⏳ | Deferred to post core trust features. |
| Swarm Inference Backend | Distributed model execution (Python) | ⏳ | Future integration; will add ROADMAP section when prototyped. |
| Extended Feature Set | Momentum, PnL, abnormalTransferFlag | ⏳ | Only MVP 6 implemented now. |
| Tests (Integrity Suite) | Tests déterminisme & chaîne | 🟡 | `test:determinism` présent; suite complète + CI gating à venir. |

Legend: ✅ Done · 🟡 In Progress · 🧪 Experimental / Interim · ⏳ Planned / Not Started

## Feature Hash Versions (Versionnage)

| Version | Canonical Input | Diff vs Précédent | Raison | Stabilité | Champs Inclus |
|---------|-----------------|-------------------|--------|-----------|---------------|
| v1 | `v=<schemaVersion>\nts=<asOfTs>\n<k>=<v>...` (ordre fixe) | Base | Timestamp `asOfTs` inclus => hash sensible au moment de capture | Conservée pour backward replay historique | schemaVersion, asOfTs, 6 valeurs MVP |
| v2 | Identique v1 mais **sans** `ts=<asOfTs>` ligne | Exclut timestamp | Réduire volatilité hash, stabiliser across replays déclenchés quelques ms plus tard | Courante (par défaut affichée) | schemaVersion + 6 valeurs MVP | 
| v3 (plan) | v2 + valeurs enrichies (momentumShortMinusLong, priceChangePct, unrealizedPnLToken, abnormalTransferFlag) + éventuellement `priceQuantized` | Ajout features étendues & prix quantifié | Étendre signal décision tout en restant deterministic; quantization prix évite micro drift | À implémenter (post abstraction PriceProvider) | +4 (ou +1 priceQuantized) champs selon readiness |

Notes:
1. Double publication: `featureHash` (v1) + `featureHashV2` (stable). Comparaisons ⇒ utiliser v2.
2. Migration v3 via constante `FEATURE_SET_VERSION=3` + nouveau `featureHashV3` (double émission temporaire).
3. `MAPPING_VERSION` (`map-v1`) trace la logique score→action; increments si changement d'algorithme.
4. Quantization prix: `quantizePrice(p)` (6 décimales) => stabilité inter-runs.
5. Transition: garder v2 + v3 pendant période d'observation (diff monitoring) avant retrait v1.

Canonical Identification (résumé):
```
// v2 (actuelle stable)
v=<schemaVersion>\n
balanceStableRatio=...\n
balanceTargetRatio=...\n
allocationDeviation=...\n
timeSinceLastTradeMins=...\n
executionsLast24h=...\n
volatilitySimple=...
```
Hash = keccak256(UTF8(payload)).

Pour v1: même contenu mais avec une ligne supplémentaire `ts=<asOfTs>` juste après `v=...`.

Pour v3 (esquisse):
```
v=<schemaVersion>\n
balanceStableRatio=...\n
balanceTargetRatio=...\n
allocationDeviation=...\n
timeSinceLastTradeMins=...\n
executionsLast24h=...\n
volatilitySimple=...\n
momentumShortMinusLong=...\n
priceChangePct=...\n
unrealizedPnLToken=...\n
abnormalTransferFlag=...\n
priceQuantized=...
```

Plan v2→v3:
1. Collecter métriques expérimentales `exp_*` (non hashées).
2. Analyse distribution & corrélation sur N décisions.
3. Activer `FEATURE_SET_VERSION=3` + double hash (v2/v3).
4. Déprécier v1, puis v2 (lecture seulement) après stabilisation.

Replay Compatibility:
- Replayer détecte version: si champ `featureHashV2` présent et pas `featureHashV3` => interprète comme set v2. Si `featureSetVersion === 3` ou `featureHashV3` présent => charge mapping v3.
- Les features supplémentaires manquantes lors d'un ancien replay sont considérées `null` / neutres.

Sécurité Hash Upgrade:
- Toute upgrade de set requiert: (a) doc, (b) commit de finalRollingHash juste avant migration, (c) script de diff montrant distribution nouvelles features avant activation.



## 0. Contexte Synthétique
Projet: Agent autonome de trading délégué sur Monad utilisant MetaMask Smart Accounts + Delegations.
Objectif: Décisions BUY / SELL / SKIP transparentes, vérifiables, re‑jouables, extensibles, sans dépendance à une API fermée.
Extension future confirmée: **Swarm inference** (backend Python) pour exécuter des modèles open / distribués, tout en conservant la reproductibilité (hash des artefacts et protocole d'appel déterministe).

---
## 1. Axes Stratégiques
| Axe | But | Cible Prix / Juges | Différenciation | Lien Delegations |
|-----|-----|--------------------|-----------------|------------------|
| IA de décision (trade) | Choisir action & taille | Best AI agent | Replay + hashes | Agent agit via permissions |
| Automatisation sécurisée | Exécutions conditionnées | On-chain automation | Guardrails + revoke auto | Permissions granulaires |
| Transparence & preuve | Audit + replay | Crédibilité technique | Hash chain + modelHash | Journal inviolable |
| Envio / HyperIndex | Features structurées | Envio bonus | FeatureHash traçable | Indexation alimentant moteur |
| Oracle (Switchboard) | Prix fiable & fail-safe | Robustesse | Mode safe fallback | Réduit attaques oracle-manip |
| Revocation service | Auto-révocation proactive | Delegations innovation | TTL + conditions | Sécurité utilisateur |
| Donation optionnelle | Narratif social | Consumer app | % sur gains / opérations | Action automatisée auditable |

---
## 2. Feature Set IA (Initial + Extensions)
| Catégorie | Feature | Description | Type | Priorité MVP | Valeur Décision | Source |
|-----------|---------|------------|------|--------------|-----------------|--------|
| Compte | balanceStableRatio | % stablecoins / total | Num | Haute | Gestion risque | viem balances |
| Compte | balanceTargetRatio | % token cible / total | Num | Haute | Rééquilibrage | viem balances |
| Allocation | allocationDeviation | |balanceTargetRatio - target| | Num | Haute | Déclenche action | Calcul interne |
| Temps | timeSinceLastTradeMins | Minutes depuis dernière exécution | Num | Haute | Anti over-trade | Audit log |
| Fréquence | executionsLast24h | Count exécutions récentes | Num | Moy | Contrôle rythme | Audit log |
| Marché | volatilitySimple | Écart-type (fenêtre locale) | Num | Moy | Taille adaptative | Prix (oracle ou synth) |
| Marché | momentumShortMinusLong | Moy. courte - longue (norm.) | Num | Moy | Direction entrée/sortie | Prix |
| Marché | priceChangePct | Variation 24h | Num | Extension | Timing | Oracle |
| Sécurité | abnormalTransferFlag | Pattern suspect | Bool | Extension | Auto-revoke | Index events |
| Performance | unrealizedPnLToken | PnL latent | Num | Extension | SELL ciblé | Historique interne |

MVP v1 (scoring) = 6 premières.

### Feature Hash (Actuel)
`featureHashV2` = keccak256(payload canonique sans timestamp). v1 conservé pour rejouer l'historique. v3 ajoutera prix quantifié + features enrichies.

---
## 3. État Actuel (Résumé)

| Domaine | État | Détails Clés | Prochain Focus |
|---------|------|-------------|----------------|
| Chaîne d'audit | ✅ Stable | rollingHash + prevEntryHash réparés; vérif scripts OK | Gating CI hard (`AUDIT_VERIFY_ON_APPEND`) |
| Feature Hash v1/v2 | ✅ | v2 stable sans timestamp; v1 legacy conservé | Préparation collecte v3 (exp_*) |
| Modèle (logistic v1) | ✅ | modelHash stable, mapping version figée | Expérimenter momentum réel (non hashé) |
| Replay Strict/Snapshot | 🟡 | Outils présents; strict peut échouer juste après modifs features | Activer hard-fail en CI (VERIFY_ALL_HARD_REPLAY) |
| Guardrails v2+ | ✅ | Motif principal + `guardrailReasonsAll` + escalade HyperIndex | Exposer streak courant dans status public |
| Auto-Revoke | ✅ | Streak HyperIndex anormal, seuil défaut=2 (force à 1 si env invalide) | Décay streak & multi-règles |
| HyperIndex + eventSetHash | ✅ (v1) | Hash deterministe 24h + hyperMetrics basiques | Multi-fenêtres (15m/1h/6h) + Merkle futur |
| Proof Pack | ✅ | build + verify + panel debug | Intégrer dans export public bundle |
| UI Transparence | ✅ | Dashboard: replay, guardrails diff, live vs stream, hyperindex | Badge streak & annotation mismatch "expected" |
| Tests | 🟡 | 8 fichiers / 16 tests (autoRevoke, hash chain, determinism) | Couverture CI complète + fail gates |
| Oracles externes | ⏳ | Abstraction designée | Intégrer Switchboard + fallback propre |
| Feature Set v3 | ⏳ | exp_* collecté partiel | Promotion champs stables + double hash v2/v3 |
| Swarm inference | ⏳ | Plan arch rédigé | Prototype appel & hash composite |
| Donation Layer | ⏳ | Spécification conceptuelle | Implémenter après robustesse core |

---
## 4. Modèle / Moteur Déterministe (TypeScript v1)
| Élément | Détail |
|---------|--------|
| Modèle | Logistic ou scoring linéaire simple |
| Input | Feature vector normalisé (0–1 sauf momentum) |
| Output score | `score = sigmoid(bias + Σ wi * fi)` |
| Mapping | score > seuil & deviation > seuil2 => BUY / SELL selon momentum; sinon SKIP |
| riskScore | Combinaison (volatilité, allocationDeviation) |
| confidence | Projection du score dans [0.4, 1.0] |
| sizePct | Function(deviation, min(maxSize * (1 - volatility))) |
| modelHash | keccak(JSON canonique des poids + meta) |

### Fichier Modèle
`strategy-model.json`:
```jsonc
{
  "version": "1",
  "arch": "logistic_v1",
  "weights": [0.12, -0.35, 0.5, 0.08, -0.2, 0.4],
  "bias": -0.1,
  "meta": { "createdAt": 1759800000000, "notes": "seed model" }
}
```
`modelHash = keccak256(canonicalJSONString(strategy-model.json))`.

---
## 5. Intégration Swarm Inference (Backend Python) (Plan)
| Aspect | Impact | Stratégie |
|--------|--------|-----------|
| Objectif | Charger un modèle (plus complexe) via un cluster / nœuds distribués | Offrir meilleur scoring évoluer sans sacrifier auditabilité |
| Interface | gRPC / HTTP local proxy Python -> Node | Conserver contrat d’E/S identique (features -> decision struct) |
| Reproductibilité | Capturer: weights hash + code hash + version | Hash composite: `modelHash = keccak(chain(codeHash, weightsHash, arch, version))` |
| Caching | Résultats local pour debug | Comparer Node pure vs Swarm output (parallèle) |
| Fallback | Si Swarm indisponible => mode TS local | Sécurité disponibilité |
| Journalisation | Ajouter `inferenceProvider: 'ts-local' | 'swarm-python'` dans `ai_decision` | Transparence source décision |
| Sécurité | Timeout + guardfail -> SKIP | Évite blocage agent |
| Alignement | Compatible avec principes (open / reproducible) | Oui si code & poids archivés |

ROADMAP.md actuel: **Ne mentionne pas Swarm explicitement** → ajouter une section dans ROADMAP lors de l’intégration réelle.

---
## 6. Délégation – Pistes d’Innovation
| Feature | Description | Bénéfice Utilisateur | Complexité | Priorité |
|---------|-------------|----------------------|------------|----------|
| TTL auto | Expiration programmée | Limite risque long terme | Faible | Haute |
| Auto-revoke conditions | Revoke sur anomalies / échecs répétés | Confiance & sécurité | Moy | Haute |
| Scoped allowances fines | Limiter token + montant + fréquence | Réduction surface d’attaque | Haut | Moy |
| Dry-run preview | Simulation sans signer | Transparence | Faible | Haute |
| Multi-role (read/trade/watch) | Délégations séparées par fonction | Cloisonnement | Moy | Moy |
| Revoke dashboard | Vue claire + bouton | UX confiance | Faible | Moy |
| Delegation proof pack | Export JSON + hash | Audit externe | Faible | Moy |

---
## 7. Guardrails (État + Extension)
| Règle | Utilité | Extension Possible |
|-------|---------|--------------------|
| maxRiskScore | Bloque décisions trop risquées | Dynamic risk envelope |
| minConfidence | Évite actions peu fiables | Ajuster selon volatilité |
| maxExecutionsPer24h | Anti sur-trading | Adaptive (volatilité basse => plus) |
| minMinutesBetweenExec | Anti rafale | Conditionnel multi-asset |
| dailyCapUsd | Plafond de dépense | Cap par token |
| (Nouveau) maxExposureAsset | Limite % total sur un actif | Multi-asset scale |
| (Nouveau) maxDrawdownSession | Stop-loss session | Suivi PnL |

Ajouter champ `guardrailReason` dans audit des exécutions bloquées.

---
## 8. Replay (Reproductibilité / Preuve)
| Étape | Action | Détail |
|-------|--------|--------|
| 1 | Sélection | Input: rollingHash d’une `ai_decision` |
| 2 | Hydratation | Recharger modèle + features selon version |
| 3 | Recalcule | Appliquer moteur (TS ou Python fallback) |
| 4 | Comparaison | action, sizePct, riskScore, confidence, modelHash, featureHash, aiRationaleHash |
| 5 | Résultat | `match: true|false` + diff list |
| 6 | Audit optionnel | Ligne `replay_check` (si voulu) |

---
## 9. Oracle / Price Provider (Abstraction)
| Usage | Pourquoi | Implémentation | Fallback |
|-------|----------|----------------|----------|
| Prix spot (WMON/USDC) | Éviter décisions basées sur bruit local | Fetch feed périodique | Marquer décision SKIP si indispo |
| Sanity check | Comparer avec dernier prix interne | Double source (cache) | Passer en mode safe |
| Momentum réel | Diff entre prix présent & moyenne | Fenêtre glissante | Degrader en pseudo-momentum |

Volatilité: calcul local (déterministe) → ne pas dépendre de feed externe pour hash stabilité.

---
## 10. Auto-Revoke (Sécurité Active)

Objectif: Révoquer automatiquement une délégation si une activité anormale de type HyperIndex est détectée de façon répétée (streak), sans intervention manuelle, pour réduire la fenêtre de risque.

### 9.1 Implémentation Actuelle
| Élément | Détail |
|---------|-------|
| Fichier état | `data/revocations.json` (persistant) |
| Module | `src/revocation.ts` (load/save + streak + revoke) |
| Endpoint statut | `GET /api/delegations/revocation/status?delegator=0x..` |
| Intégration décision | Dans endpoint décision: incrémente streak si `guardrailReason === 'abnormal_hyperindex_activity'` |
| Seuil | `AUTO_REVOKE_ABNORMAL_STREAK` (défaut 2) |
| Action audit | Ligne avec `action: 'revoke'` dans audit chain |
| Blocage décision forcée | `/api/strategy/decision/force` refuse si révoqué |
| Guardrail source | HyperIndex flag `abnormal_hyperindex_activity` (heuristique events_transfer_24h > 50) |

### 9.2 Flux de Données
1. Décision générée → Guardrails évaluent anomalies.
2. Si anomalie HyperIndex: guardrail bloque (raison `abnormal_hyperindex_activity`) et `recordGuardrailHit` incrémente le compteur.
3. `maybeAutoRevoke` compare streak au seuil → si atteint, `revokeDelegation` est appelé.
4. Audit append: ligne `revoke` avec `guardrailReason`.
5. Endpoints critiques (force decision, exécutions futures à ajouter) renvoient 403 avec payload informant la révocation.
6. Front / script peut interroger l'état via endpoint statut.

### 9.3 Structure du Fichier `revocations.json`
```jsonc
{
  "revocations": [
    { "delegator": "0xabc...", "revokedAt": 1759999999999, "reason": "auto_revoke_abnormal_hyperindex" }
  ],
  "streaks": {
    "0xabc...": { "abnormalHyperIndex": 2, "lastUpdated": 1759999999000 }
  }
}
```

### 9.4 Ligne d'Audit (action 'revoke')
Champs clés (extrait):
```
ts=<epoch_ms>
action=revoke
delegator=0x...
guardrailReason=auto_revoke_abnormal_hyperindex
rollingHash=<nouveauRolling>
prevEntryHash=<hashLignePrecedenteSansRolling>
```
Les champs non pertinents (modelHash, featureHash, etc.) peuvent être absents / vides; la canonicalisation rollingHash reste cohérente grâce au recalcul interne.

### 9.5 Endpoint Statut
`GET /api/delegations/revocation/status?delegator=0x...` →
```json
{ "ok": true, "revoked": false, "record": null, "abnormalStreak": 1 }
```
Si révoqué:
```json
{ "ok": true, "revoked": true, "record": { "delegator": "0x...", "revokedAt": 1759..., "reason": "auto_revoke_abnormal_hyperindex" }, "abnormalStreak": 2 }
```

### 9.6 Variables d'Environnement
| Variable | Description | Défaut |
|----------|-------------|--------|
| `AUTO_REVOKE_ABNORMAL_STREAK` | Nombre de blocages consécutifs avant révocation | 2 |
| `BLOCK_ON_ABNORMAL_HYPERINDEX` | Active le guardrail bloquant | true (via config interne) |

### 9.7 Simulation & Démo
Scripts existants: `simulate-hyperindex-anomaly` (génère rafales d'events). Prochain: script combiné (à implémenter) qui:
1. Injecte anomalies jusqu'à déclencher `abnormal_hyperindex_activity`.
2. Appelle l'endpoint décision en boucle.
3. Affiche confirmation de révocation + extrait dernière ligne audit.

### 9.8 Extension Future
| Axe | Idée | Bénéfice |
|-----|------|----------|
| Multi-règles | Ajouter seuil sur `maxExecutionsPer24h` | Couvrir sur-trading |
| Décay streak | Réduire streak après X décisions propres | Éviter révocation permanente injustifiée |
| TTL temporaire | Révoquer pour N heures avant réactivation | Limiter downtime total |
| UI Badge | Indicateur rouge + bouton Justify | Transparence utilisateur |
| Manual override | Endpoint POST /reinstate | Restauration contrôlée |
| Merkle proof | Preuve de révocation signée | Audit externe trustless |

### 9.9 Sécurité & Fiabilité
| Risque | Mitigation |
|--------|-----------|
| Faux positifs (seuil fixe) | Passer à seuil dynamique (distribution historique) |
| Écriture corrompue revocations.json | Write atomique (future: fs.rename temp) |
| Race multi-process | Instance unique recommandée (future: lockfile) |
| Suppression manuelle fichier | Rejouer audit pour reconstituer (garder preuves) |

### 9.10 Prochaines Étapes (Auto-Revoke)
1. Script simulation combiné.
2. UI: badge révocation + désactivation bouton force decision.
3. Décay streak (optionnel) après N décisions propres.
4. Extension multi-règles (expositions, échecs prix) avec codes distincts.

Résumé: La révocation automatique est opérationnelle pour la première règle critique (activité transfert anormale). Elle est **déterministe**, **auditée**, et **extensible** via un simple enrichissement du module `revocation.ts` sans casser la chaîne d'audit.

---
## 11. Donation Automatique (Phase Future)
| Mode | Description | Valeur |
|------|------------|--------|
| % par trade | Prélève x% de la valeur d’un BUY | Impact régulier |
| % des gains | Part des profits réalisés | Alignement performance |
| Budget mensuel | Limite supérieure | Prévisibilité |
| Matching réussite | Bonus si winRate > seuil | Incentive |
| Destinations | Gitcoin, Giveth, Endaoment, UNICEF CryptoFund, SaveTheChildren | Légitimité |
| Audit | Ligne `donation` (montant, destHash) | Transparence |

---
## 12. Innovation – Classement Interne
| Idée | Impact Démo | Complexité | Priorité |
|------|-------------|------------|----------|
| Replay vérifiable | Très haut | Faible | Haute |
| modelHash + featureHash | Très haut | Moy | Haute |
| Oracle prix + safe mode | Haut | Moy | Moy-Haute |
| Auto-revoke dynamique | Haut | Moy | Moy-Haute |
| SSE audit live | Moyen+ | Moy | Moyen |
| Donation layer | Moyen | Faible | Basse (Phase 2) |
| Swarm inference | Haut (différenciation) | Moy-Haut | Après moteur v1 stable |

---
## 13. Milestones Alignés
| Milestone | Contenu | Résultat Visible |
|-----------|---------|------------------|
| M1 | Structure décision trade | BUY/SELL/size apparait |
| M2 | Features + featureHash | Décisions hashées reproductibles |
| M3 | Modèle v1 + modelHash | IA déterministe affichée |
| M4 | Replay + guardrailReason | Démo preuve d’intégrité |
| M5 | UI de pilotage | Agent compréhensible |
| M6 | Oracle + auto-revoke + SSE | Robustesse accrue |
| M7 | Swarm inference + docs complètes | Différenciation AI avancée |
| M8 | Donation + multi-asset | Narratif élargi |

---
## 14. Champs à Ajouter dans Audit (Évolution)
| Champ | Quand | Raison |
|-------|-------|--------|
| modelHash | ai_decision | Rejeu fiable |
| inferenceProvider | ai_decision | Indiquer source (ts-local / swarm-python) |
| guardrailReason | execute (blocked) | Analyse claire |
| replayMatch | replay_check | Validation publique |
| donationAmount / dest | donation | Traçabilité sociale |
| delegationTTL | build/submit | Expirations prouvées |

---
## 15. Sécurité & Reproductibilité (Swarm)
| Point | Mesure |
|-------|--------|
| Divergence cluster | Comparer sortie cluster vs simulation locale (mode debug) |
| Non-déterminisme | Interdire random sans seed hashée | 
| Version drift | Invalider décision si modelHash mismatch | 
| Timeout | Fallback local + audit warning | 

---
## 16. Décisions à Valider (Prochain Sprint)
| Question | Options | Recommandé |
|----------|---------|------------|
| Implémenter features MVP | 6 de base / +PnL / +Sentiment | 6 de base |
| Intégrer Switchboard timing | Immédiat / Après M3 | Après M3 |
| Lancer Swarm prototype | Avant v1 locale / Après | Après moteur stable |
| Donation timing | MVP / Post M7 | Post M7 |
| Multi-asset | MVP / Phase 2 | Phase 2 |

---
## 17. Prochaines Actions (MàJ)
1. Documentation README: flags verify-all, versioning, pricing.
2. Intégrer prix quantifié dans v3 (non hashé → hashé après validation).
3. Scripts analyse momentum / priceChange.
4. Activer FEATURE_SET_VERSION=3 (double publication) & surveiller diff.
5. Ajout tests CI (audit, determinism, proof-pack).

---
## 18. NOTE sur ROADMAP.md
Le fichier actuel **ne mentionne pas encore explicitement Swarm inference** → ajouter une section "Future AI Execution Layer" lors de l’intégration.

---
## 19. Glossaire Express
| Terme | Sens |
|-------|------|
| featureHash | Hash des données d’entrée d’une décision |
| modelHash | Hash du modèle (code + poids) |
| replay | Vérification d’une décision passée |
| guardrailReason | Motif précis d’un blocage |
| inferenceProvider | Source de calcul de la décision |
| Swarm inference | Inference distribuée (backend Python), open & hashée |

---
_Fin du document._

---

## 20. Tableau Risques & Mitigations (Focus MVP Déterministe)
| Risque | Impact | Prob. | Mitigation | Signal d'Alerte | Action Immédiate |
|--------|--------|-------|------------|------------------|------------------|
| Non-déterminisme features (arrondi) | Replay échoue | Moy | Normalisation décimales fixe (8) + tri | Hash mismatch sporadique | Stop commits, corriger normalisation |
| Drift modèle (modif du JSON) | Historique invalide | Faible | Versionner chaque `modelHash` immuable | Anciennes décisions mismatch | Archiver copie `/models/<modelHash>.json` |
| Oracle indispo | Décision SKIP intempestive | Moy | Snapshot valeur + fallback ancien prix | Logs SKIP "oracle_unavailable" | Passer en mode prix cache |
| Surcharge audit I/O | Latence / blocage event loop | Faible | Append stream + batching futur | Latence > 50ms par append | Introduire buffer mémoire |
| Guardrails trop stricts | 0 exécutions | Moy | Monitoring taux de blocage | >90% décisions bloquées | Ajuster config + reload |
| Bug replay script | Perte crédibilité démo | Faible | Test automatisé sur 3 décisions | Test CI échoue | Hotfix script avant démo |
| Absence tests intégrité | Régressions silencieuses | Moy | Écrire tests J<=5 | PR sans tests nouveaux | Bloquer merge |
| Single dev surcharge | Glissement planning | Haut | Plan journalier granulaire | Tâches >1 jour décalées | Réduire scope stretch |
| Crash process (SSE) | Perte streaming | Faible | Isoler SSE code simple | SSE déconnecte souvent | Ajouter health-check |
| Arrêt inattendu (SIGTERM) | Audit partiel | Faible | Flush sync final dans handler | RollingHash manquant | Implémenter shutdown hook |

## 21. Spécification Hashing Canonique
Objectif: Garantir que toute recomputation sur machine tierce produit un hash identique.

Principes:
1. Structure JSON minimaliste sans espaces superflus (utiliser `JSON.stringify` par défaut Node, clés déjà ordonnées).
2. Ordonner explicitement les listes (features) dans un ordre figé défini dans `features.ts` (table EXPORT). Ne jamais trier dynamiquement selon valeurs.
3. Normaliser chaque nombre avant insertion: `Number.parseFloat(value).toFixed(8)` puis re-cast en nombre (évite strings longues) ou conserver string stable si nécessaire.
4. Aucune inclusion de champs volatils (timestamps temps réel) dans `featureHash` sauf si arrondis à la minute ET documenté.
5. `modelHash = keccak256(JSON.stringify(modelCanonical))` où `modelCanonical` contient uniquement: version, arch, weights, bias, meta.versionTag (pas de createdAt si variable) OU si `createdAt` conservé, il devient immuable.
6. `decisionRollingHash` reste chaîne d’ancrage; `featureHash` et `modelHash` entrent dans le calcul de `ai_decision` lineHash via contenu sérialisé complet.
7. Éviter floating accumulations: dériver dérivés (e.g. volatility) en utilisant formules stables et arrondi final.

Pseudo-code feature hash:
```
const FEATURE_ORDER = ['balanceStableRatio','balanceTargetRatio','allocationDeviation','timeSinceLastTradeMins','executionsLast24h','volatilitySimple'];
const vals = FEATURE_ORDER.map(k => norm(features[k])); // norm => toFixed(8) -> parseFloat
const payload = { v:1, f: vals };
return keccak256(JSON.stringify(payload));
```

## 22. Plan (Révisé)
Focus actuel: stabilité v2, instrumentation métriques v3, documentation, tests.

### 21.1 Procédure Migration Audit Sûre
Objectif: recalculer la chaîne (prevEntryHash + rollingHash) sans risque de lignes intercalées.
Étapes:
1. `npm run api:stop`
2. `npm run audit:migrate`
3. `npm run verify:audit`
4. `npm run api:start`

Flags conseillés runtime:
| Variable | Effet |
|----------|-------|
| `AUDIT_VERIFY_ON_APPEND=1` | Vérification légère post-append (dernière ligne) |
| `AUDIT_REFUSE_STALE=1` | Refuse append si un `prevEntryHash` legacy obsolète est fourni |

Sécurité: l'implémentation ignore de toute façon les champs chain fournis et les recalcule; le flag de refus transforme une divergence en erreur au lieu d'un avertissement.

## 23. Métriques de Succès MVP
| Métrique | Cible | Vérification |
|----------|-------|--------------|
| Taux de décisions re-jouables | 100% | Replay script sur N dernières |
| Taux de hash mismatch | 0 | Tests CI |
| Décisions bloquées par guardrails | <70% (config calibrée) | Effectiveness endpoint |
| Latence génération décision | <150ms local | Log timestamps |
| Latence append audit | <50ms | Profil simple |
| Couverture tests critiques | >=5 tests clés | npm test |

## 24. Modifs Fichiers (Historique → État)
La plupart réalisés; restent: v3 features, oracles.

## 25. Checklist Avant Démo
1. `npm run verify:audit` => OK
2. `node scripts/replay --last 5` => Tous VERIFIED
3. UI affiche dernière décision + guardrail status
4. Une décision BUY/SELL + une décision SKIP visible
5. Hashes (featureHash, modelHash) présents dans audit lines
6. README explique reproduction & vérification
7. Guardrail block raison lisible (ex: `maxExecutionsPer24h`)
8. Pas d'erreurs TypeScript build
9. Process SSE stable 5 min
10. Script exemples (curl) fonctionnels

## 26. HyperIndex & eventSetHash (Priorité 2 - Implémenté Partiellement)

Objectif: disposer d'une empreinte (hash) déterministe du sous-ensemble d'événements récents utilisés pour enrichir le contexte décision sans modifier les `featureHash` existants.

### 25.1 eventSetHash (v1)
- Fenêtre: 24h (param par défaut `rangeMs=86400000`).
- Canonicalisation: lignes `v=1`, `rangeMs=<ms>`, `asOfTs=<now>`, puis chaque événement trié par `(ts,id)` formatté `id|ts|type|price|amountQuote`.
- Normalisation numérique: `toFixed(8)` puis cast => stabilité.
- Hash: keccak256(hex(UTF8(payload))) aligné style interne.
- Stockage: ajouté dans les lignes `ai_decision` sous `eventSetHash` + object `hyperMetrics` (agrégats 24h basiques: `priceChangePct_24h`, `volatility_24h`, compte par type `events_<type>_24h`).

### 25.2 expFeatures (Collecte Passive v3)
Injecté dans `provenance.expFeatures` (et audit) sans entrer dans `featureHashV2`:
| Champ | Source | Statut | Note |
|-------|--------|--------|------|
| `exp_momentum` | Placeholder (reuse `priceChangePct_24h`) | 🧪 | Remplacé plus tard par (courte - longue) |
| `exp_abnormalTransferFlag` | Heuristique `events_transfer_24h > 50` | 🧪 | Seuil futur dynamique (MAD / baseline) |
| `exp_quantizedPrice` | `snapshotPrice` (quantized) | 🧪 | Utilisera oracle réel plus tard |
| `exp_pnlRealized` | (null) | ⏳ | Nécessite tracking position vs prix d'entrée |

Raison de la séparation: permettre d'observer stabilité & valeur prédictive avant promotion en v3 (`FEATURE_SET_VERSION=3`).

### 25.3 Vérification
Script `verify-hyperindex` étendu: recalcule featureHash HyperIndex ET tente de recomposer `eventSetHash` localement si présent dans la réponse API.

### 25.4 Migration Futur v3
1. Ajouter fenêtres multiples côté HyperIndex (15m,1h,6h). 
2. Recalcul exp_momentum = priceChange(15m) - priceChange(1h) normalisé.
3. Introduire `featureHashV3` incluant les champs promus.
4. Double publication v2/v3 sous drapeau `FEATURE_SET_VERSION=3`.

### 25.5 Limites Actuelles
- `eventSetHash` couvre seulement 24h (pas multi-fenêtres encore).
- `exp_momentum` provisoire, non significatif.
- `abnormalTransferFlag` seuil statique.
- Absence de Merkle / hashing par fenêtre — simplification volontaire (surveiller taille events.log).

### 25.6 Dashboard (Temps Réel – Plan Multi-Asset)
Le futur dashboard (multi-actifs / protocoles) affichera, par actif ou protocole indexé via Envio:

| Metric | Description | Usage | Source |
|--------|-------------|-------|--------|
| users_daily | Nombre d'utilisateurs distincts sur 24h | Adoption / filtrage anomalies | HyperIndex (distinct addresses) |
| tx_daily | Nombre de transactions / 24h | Volume opérationnel | HyperIndex events |
| tx_cumulative | Total historique depuis genesis indexée | Croissance | HyperIndex (accumulate) |
| avg_tx_per_user | tx_daily / users_daily | Engagement moyen | Calcul dérivé |
| avg_tx_fee_protocol | Frais moyens sur les tx (si mesurable) | Coût d'accès / rentabilité | Events enrichis (gas / fee) |
| volatility_24h | Déjà présent (prix) | Taille adaptative | HyperIndex price events |
| momentum_short_long | Variation courte - longue | Signal décision v3 | Fenêtres multiples |
| abnormalTransferFlag | Pattern transferts anormaux | Guardrail / auto-revoke | Heuristique + distribution |

Ces métriques seront progressivement intégrées en v3/v4: d'abord en lecture dans UI, ensuite (sélection) dans `featureHashV3` après validation de stabilité & utilité.

### 25.7 Guardrail HyperIndex
Nouveau flag config: `blockOnAbnormalHyperIndex` (par défaut true) bloque une exécution si `abnormalTransferFlag` est détecté dans le contexte hyperindex (raison `abnormal_hyperindex_activity`).

### 25.8 Roadmap Multi-Asset
1. Étendre ingestion pour tagger `asset` ou `protocol` par événement.
2. Maintenir des agrégats normalisés par actif (fenêtres 15m/1h/6h/24h).
3. Promouvoir momentum & volume normalisé inter-actifs (z-score) dans v3.
4. Sélection d'actif cible adaptative (ex: réallouer vers actif avec momentum positif et faible volatilité relatifs).
5. Bascule du moteur: de décision unique (WMON) à boucle multi-actifs (portefeuille) avec allocation vectorielle.


---
Fin des ajouts complémentaires.


## 27. Guardrails v2+ Observabilité & Auto-Revoke (Nouveaux Ajouts)

Objectif: rendre chaque blocage / escalade explicable, traçable et réversible tout en automatisant la révocation après un motif anormal répété.

### 26.1 `guardrailReasons` vs `guardrailReasonsAll`
Historique: auparavant un seul champ `guardrailReason` (primaire) pouvait masquer une cause critique secondaire (ex: `abnormal_hyperindex_activity` masquée par `feature_hash_mismatch`).

Ajout: `guardrailReasonsAll` (array ordonnée) dans:
1. Réponses endpoints prévisualisation / force (`/api/strategy/preview`, `/api/strategy/force`).
2. Lignes audit `ai_decision` et `ai_decision_preview` (champ `guardrailReasonsAll`).
3. Endpoint diagnostic `/api/strategy/guardrails/last`.

Rôle: conserver l'ensemble des motifs évalués comme bloquants OU informatifs (warnings promus) pour analyse forensique / tuning.

### 26.2 Escalade Motif HyperIndex Anormal
Problème: un `feature_hash_mismatch` (attendu lors d'évolution contrôlée) peut reléguer au second plan une activité réellement suspecte (`abnormal_hyperindex_activity`).

Logique d'escalade:
- Si `abnormal_hyperindex_activity` présent ET `feature_hash_mismatch` est motif primaire, on promeut `abnormal_hyperindex_activity` en motif principal (`guardrailReason`).
- `feature_hash_mismatch` reste listé dans `guardrailReasonsAll` (visibilité conservée).

Effet: automation (streak / auto-revoke) s'appuie toujours sur un motif critique priorisé.

### 26.3 Endpoint: `GET /api/strategy/guardrails/last`
Retourne le dernier objet d'évaluation (memo en mémoire) incluant:
- `reason` (primaire après escalade)
- `reasonsAll`
- flags / métriques sous-jacents (selon implémentation existante)
Usage: inspection temps réel sans chercher dans l'audit complet.

### 26.4 Badge Révocation dans `/api/strategy/decision/latest`
Champ ajouté: `revoked: boolean` (ou métadonnée équivalente) reflétant état courant de la délégation (lecture depuis module révocation). Permet au front d'afficher immédiatement le statut d'arrêt de sécurité.

### 26.5 Auto-Revoke par Streak Anomalies HyperIndex
Variable d'environnement: `AUTO_REVOKE_ABNORMAL_STREAK` (entier >=1).
Pipeline:
1. À chaque blocage avec motif primaire `abnormal_hyperindex_activity`, incrémenter streak persisté (fichier `revocations.json`).
2. Si `streak >= threshold` => entrée `revoke` audit + marquage persistant (empêche exécutions futures tant que non restauré manuellement).
3. Toute décision non anormale (ou clear explicite) remet le streak à 0.

Tests (Vitest): `tests/autoRevoke.test.ts` couvre escalade + incrément + déclenchement + reset.

### 27.6 Validation Startup
Au démarrage: parse de `AUTO_REVOKE_ABNORMAL_STREAK`.
- Si absent: le code utilise la valeur par défaut (2) lors du calcul dans `revocation.ts`.
- Si présent mais invalide (<1 ou NaN): forcé à `1` et une ligne d'audit `auto_revoke_threshold_adjusted` est ajoutée.
- Si valide (>=1): valeur acceptée telle quelle (stabilité prévisible).

### 26.7 Flag Debug Granulaire
`DEBUG_GUARDRAILS=1` active logs détaillés (évaluation, escalade) sans polluer en production par défaut. Tous les logs passent par utilitaire central garantissant absence sans flag.

### 26.8 Schéma Audit (Champs Ajoutés)
Entrées `ai_decision*` enrichies:
- `guardrailReasonsAll`: string[] (optionnel si vide)
- (Déjà existant) `guardrailReason`: string primaire (éventuellement escaladé)
- `revoked` n'est pas dans chaque ligne décision mais reflet via endpoint; la révocation elle-même génère une ligne `revoke` dédiée.

### 26.9 Consommation Client
Front peut:
- Afficher motif principal + expander pour lister `guardrailReasonsAll`.
- Mettre en évidence motif escaladé (UI: badge "Escaladé").
- Montrer compteur streak courant (option: endpoint futur `/api/strategy/revocations/status`).

### 26.10 Sécurité & Intégrité
Invariant: aucune modification de la chaîne cryptographique (hashing d'entrée) — champs ajoutés sont purement additionnels dans payload; `prevEntryHash` et `rollingHash` restent dérivés du contenu complet, donc prouvabilité conservée.

### 26.11 Prochaines Étapes Potentielles (Non Implémentées)
- Export métrique temps réel `abnormalHyperIndexStreak` dans endpoint status.
- Paramétrage dynamique seuil auto-revoke (percentile anomalies glissant).
- Ajout Merkle root des events HyperIndex multi-fenêtres.
- Endpoint unifié audit slice filtré par motif guardrail.

---
Fin section 26.


