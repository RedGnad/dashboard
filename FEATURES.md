# FEATURES & STRATEGY DESIGN

_Last updated: 2025-10-07_

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

### Feature Hash
`featureHash = keccak256(JSON.stringify({ v:1, features:[orderedValues] }))` (ordre figé → reproductible).

---
## 3. Modèle / Moteur Déterministe (TypeScript v1)
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
## 4. Intégration Swarm Inference (Backend Python)
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
## 5. Délégation – Pistes d’Innovation
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
## 6. Guardrails (État + Extension)
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
## 7. Replay (Reproductibilité / Preuve)
| Étape | Action | Détail |
|-------|--------|--------|
| 1 | Sélection | Input: rollingHash d’une `ai_decision` |
| 2 | Hydratation | Recharger modèle + features selon version |
| 3 | Recalcule | Appliquer moteur (TS ou Python fallback) |
| 4 | Comparaison | action, sizePct, riskScore, confidence, modelHash, featureHash, aiRationaleHash |
| 5 | Résultat | `match: true|false` + diff list |
| 6 | Audit optionnel | Ligne `replay_check` (si voulu) |

---
## 8. Oracle Switchboard – Usage Ciblé
| Usage | Pourquoi | Implémentation | Fallback |
|-------|----------|----------------|----------|
| Prix spot (WMON/USDC) | Éviter décisions basées sur bruit local | Fetch feed périodique | Marquer décision SKIP si indispo |
| Sanity check | Comparer avec dernier prix interne | Double source (cache) | Passer en mode safe |
| Momentum réel | Diff entre prix présent & moyenne | Fenêtre glissante | Degrader en pseudo-momentum |

Volatilité: calcul local (déterministe) → ne pas dépendre de feed externe pour hash stabilité.

---
## 9. Revocation Service (Automatisé)
| Composant | Fonction | Triggers |
|-----------|----------|----------|
| Scanner | Parcours délégations actives | Cron / On-demand |
| Analyse | Vérifie seuils (échecs, montant cumulé) | Règles config |
| Action | Soumet transaction de revoke | Guardrail violation |
| Journal | Ajoute ligne `delegation_revoke` | Preuve | 
| UI | Indicateur + bouton Revoke | Interaction utilisateur |

---
## 10. Donation Automatique (Phase Future)
| Mode | Description | Valeur |
|------|------------|--------|
| % par trade | Prélève x% de la valeur d’un BUY | Impact régulier |
| % des gains | Part des profits réalisés | Alignement performance |
| Budget mensuel | Limite supérieure | Prévisibilité |
| Matching réussite | Bonus si winRate > seuil | Incentive |
| Destinations | Gitcoin, Giveth, Endaoment, UNICEF CryptoFund, SaveTheChildren | Légitimité |
| Audit | Ligne `donation` (montant, destHash) | Transparence |

---
## 11. Innovation – Classement Interne
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
## 12. Milestones Alignés
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
## 13. Champs à Ajouter dans Audit (Évolution)
| Champ | Quand | Raison |
|-------|-------|--------|
| modelHash | ai_decision | Rejeu fiable |
| inferenceProvider | ai_decision | Indiquer source (ts-local / swarm-python) |
| guardrailReason | execute (blocked) | Analyse claire |
| replayMatch | replay_check | Validation publique |
| donationAmount / dest | donation | Traçabilité sociale |
| delegationTTL | build/submit | Expirations prouvées |

---
## 14. Sécurité & Reproductibilité (Swarm)
| Point | Mesure |
|-------|--------|
| Divergence cluster | Comparer sortie cluster vs simulation locale (mode debug) |
| Non-déterminisme | Interdire random sans seed hashée | 
| Version drift | Invalider décision si modelHash mismatch | 
| Timeout | Fallback local + audit warning | 

---
## 15. Décisions à Valider (Prochain Sprint)
| Question | Options | Recommandé |
|----------|---------|------------|
| Implémenter features MVP | 6 de base / +PnL / +Sentiment | 6 de base |
| Intégrer Switchboard timing | Immédiat / Après M3 | Après M3 |
| Lancer Swarm prototype | Avant v1 locale / Après | Après moteur stable |
| Donation timing | MVP / Post M7 | Post M7 |
| Multi-asset | MVP / Phase 2 | Phase 2 |

---
## 16. Prochaines Actions (si validation immédiate)
1. Ajouter `targetAsset`, `side`, `sizePct` à decision + audit.
2. Implémenter `features.ts` + hash stable.
3. Créer `strategy-model.json` + loader + `modelHash`.
4. Étendre preview pour sortir nouvelle structure.
5. Ajouter champ `inferenceProvider: 'ts-local'`.
6. Préparer squelette endpoint replay.

---
## 17. NOTE sur ROADMAP.md
Le fichier actuel **ne mentionne pas encore explicitement Swarm inference** → ajouter une section "Future AI Execution Layer" lors de l’intégration.

---
## 18. Glossaire Express
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

## 19. Tableau Risques & Mitigations (Focus MVP Déterministe)
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

## 20. Spécification Hashing Canonique
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

## 21. Plan 10 Jours (Single Dev Adapté)
| Jour | Objectifs Concrets | Livrables | Mesure de Finition |
|------|--------------------|-----------|--------------------|
| 1 | Endpoint execute (delegator + selection) + guardrailReason champ | Code + test manuel curl | Audit lines contiennent guardrailReason |
| 2 | `features.ts` (collecte + normalisation) + featureHash | Fichier + preview inclut hash | Re-run preview -> hash stable |
| 3 | `strategy-model.json` + loader + modelHash + ai_decision enrichi | Fichier + champ modelHash | Deux runs identiques => même modelHash |
| 4 | Replay script (CLI) + endpoint stub | `scripts/replay.ts` + route | `node scripts/replay --last 1` => VERIFIED |
| 5 | Tests: audit chain, determinism, guardrails | `/tests` + npm test | 5 tests PASS | 
| 6 | SSE audit stream + UI console skeleton (liste dernières lignes) | Endpoint `/api/audit/stream` + React component | SSE arrive <2s dans UI |
| 7 | UI enrichie (metrics, dernier decision, guardrails status) | Dashboard simple | 5 sections visibles | 
| 8 | Auto-revoke TTL simple + route listing | TTL config + endpoint `/api/routes` | Revoke plan log after TTL | 
| 9 | Docs (PROJECT_GOALS.md, update README, enrich FEATURES) | Fichiers docs | Replay how-to lisible | 
| 10 | Durcissement + polish (refactor mineurs, exemples curl) | Scripts examples + final check | Full replay historique OK |

Stretch si avance < Jour 8: Oracle snapshot + volatility réelle.

## 22. Métriques de Succès MVP
| Métrique | Cible | Vérification |
|----------|-------|--------------|
| Taux de décisions re-jouables | 100% | Replay script sur N dernières |
| Taux de hash mismatch | 0 | Tests CI |
| Décisions bloquées par guardrails | <70% (config calibrée) | Effectiveness endpoint |
| Latence génération décision | <150ms local | Log timestamps |
| Latence append audit | <50ms | Profil simple |
| Couverture tests critiques | >=5 tests clés | npm test |

## 23. Prochaines Modifs Fichiers (Préparation)
| Fichier | Ajout / Création | Rôle |
|---------|------------------|------|
| `src/features.ts` | Nouveau | Collecte + normalisation + featureHash |
| `strategy-model.json` | Nouveau racine ou `data/model/` | Poids déterministes |
| `src/replay.ts` ou `scripts/replay.ts` | Nouveau | Rejeu vérification CLI |
| `src/server.ts` | Update | Endpoint replay + SSE audit |
| `src/audit.ts` | Update | Ajout champs guardrailReason (si blocked) |
| `src/strategy/` (optionnel) | Nouveau dossier | Isolation logique modèle |
| `PROJECT_GOALS.md` | Nouveau | Justification open deterministic |

## 24. Checklist Avant Démo
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

---
Fin des ajouts complémentaires.


