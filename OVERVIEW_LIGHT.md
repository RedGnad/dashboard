# DCA Autonomous Wallet – Vue Ultra Simple

> Pour un utilisateur / jury qui découvre. Pas de jargon inutile.

## 1. C'est quoi ?
Un petit "cerveau" qui décide périodiquement s'il faut BUY, SELL ou SKIP un token (mode DCA) et qui **prouve** qu'il n'a rien triché après coup.

## 2. Pourquoi c'est fiable ? (4 briques)
1. Chaîne d'audit: chaque décision est liée à la précédente par un hash (impossible de réécrire en douce).
2. Features hashées: les données d'entrée (ratios, volatilité...) sont sérialisées -> `featureHashV2` (stable).
3. Modèle hashé: le fichier du modèle est fingerprinté -> `modelHash`. Même modèle = mêmes sorties.
4. Replay: on peut recalculer la décision localement; si ça diffère = alerte immédiate.

=> Transparence: pas de boîte noire. On peut prouver après coup que l'agent n'a pas "inventé" une décision.

## 3. Comment vérifier en 30s
1. Récupérer la dernière décision:
```bash
curl -s http://localhost:8787/api/strategy/decision/latest | jq
```
2. Lancer les vérifications locales:
```bash
npm run verify:all
```
3. Regarder la ligne de résumé (doit afficher PASS). Si mismatch → ça clignote dans la console.

## 4. Ce que veulent dire les principaux champs
| Champ | Signification courte |
|-------|----------------------|
| rollingHash | Tête actuelle de la chaîne (empreinte cumulée) |
| featureHashV2 | Hash des features (sans timestamp) |
| modelHash | Empreinte du modèle utilisé |
| aiRationaleHash | Hash d'un texte explicatif (on n'a pas besoin du texte pour vérifier) |
| riskScore | Score de risque (0–100) |
| confidence | Confiance (0–1) |
| momentumShortMinusLong | Indication tendance (positif = plutôt haussier) |

## 5. Guardrails (sécurité)
Avant une exécution réelle, des règles simples peuvent bloquer (trop de trades, trop rapprochés, risque trop haut, etc.). Si bloqué → raison stockée.

## 6. Ce qui arrive ensuite (focus impact)
Ordre orienté preuves d’exécution et de données:
1. Intégrer le stub OpenGradient (Swarm inference) via `INFERENCE_PROVIDER=opengradient_stub` et ajouter `inferenceProofHash` à l’audit.
2. Activer Switchboard (Surge) pour le prix spot avec quantization 6 décimales + fallback synthétique; exposer `priceQuantized` (shadow v3).
3. Proof Pack v2: inclure `inference.json` et adapter le script de vérification pour re-hash du blob.
4. Ensuite: corrections TS, donation_intent, et polissage UI.

## 7. Comment lire une décision (exemple simplifié)
```jsonc
{
  "actionType": "SKIP",
  "riskScore": 42,
  "confidence": 0.91,
  "featureHashV2": "0x...",
  "modelHash": "0x...",
  "momentumShortMinusLong": 0.0031,
  "rollingHash": "0x..."
}
```
Si vous rejouez localement (script) et obtenez les mêmes valeurs clés → la décision est authentique.

## 8. Foire rapide (FAQ)
| Question | Réponse courte |
|----------|----------------|
| Peut-on falsifier une ancienne décision ? | Très difficile: la chaîne casserait (hash mismatch). |
| Et si le modèle change ? | Nouveau `modelHash`; historique ancien reste vérifiable. |
| Que se passe-t-il si le prix est indisponible ? | Mode synthétique; c'est visible (source). |
| Le momentum est-il dans le hash ? | Pas encore (expérimental), donc ne casse rien. |

## 9. Commandes utiles
```bash
npm run verify:all      # Vérifications agrégées
npm test                # Tests unitaires (chaîne, features...)
```

## 10. Résumé en une phrase
Un agent DCA dont chaque décision est **hashée, chaînée et rejouable** – on ne vous demande pas de croire, on vous donne les preuves.

## 11. Donations (nouvelle fonctionnalité légère)
Vous pouvez définir qu'un pourcentage (1–100%) de chaque montant DCA théorique est marqué comme part « donation » vers une adresse caritative de votre choix.

### Comment configurer
```bash
curl -X POST http://localhost:8787/api/donations/intent \
  -H 'Content-Type: application/json' \
  -d '{"delegator":"0x...","pct":5,"to":"0xAdresseCaritative"}'
```

Lire la configuration:
```bash
curl -s http://localhost:8787/api/donations/config/0x... | jq
```

### Où c'est stocké
Dans le fichier de délégation (`data/delegations/<delegator>.json`) sous `job.donation`:
```jsonc
"donation": { "pct": 5, "to": "0x...", "updatedAt": 1730xxxxxxx }
```

### Audit
Chaque mise à jour écrit une entrée `donation_intent` dans `audit.log` (chaîne d'audit). On peut la retrouver avec:
```bash
grep donation_intent data/delegations/audit.log | tail -n 1 | jq
```

### Stratégie preview
L'endpoint `/api/strategy/preview` renvoie un bloc `donation` si configuré:
```jsonc
"donation": { "pct": 5, "to": "0x...", "amountInUSDC": 10, "donationUsd": 0.5 }
```
Pour l'instant c'est un calcul informatif (pas encore de transfert on-chain automatisé).

### Pourquoi c'est utile
Montre que le moteur peut intégrer facilement une couche « impact social » traçable sans fragiliser la vérifiabilité des décisions de base.

## 12. Changer de provider d'inférence (Local vs OpenGradient Stub)
Le moteur peut utiliser soit le modèle local TypeScript, soit un provider externe (stub OpenGradient pour l'instant) sans casser la vérifiabilité.

### Variables d'environnement
```bash
INFERENCE_PROVIDER=local                # (défaut) utilise strategy-model.json
INFERENCE_PROVIDER=opengradient_stub    # active le stub déterministe
OG_MODEL_CID=stub-model-cid             # optionnel (tag dans les métadonnées)
OG_INFERENCE_MODE=VANILLA               # méta (placeholder)
```

### Vérifier le provider actif
```bash
curl -s http://localhost:8787/api/inference/provider | jq
```
Réponse exemple:
```jsonc
{ "ok": true, "provider": "opengradient-stub", "env": "opengradient_stub" }
```

### Effet sur les décisions
- `meta.inferenceProvider` reflète la source (`ts-local` ou `opengradient-stub`).
- `modelHash` change si provider change (traçable dans audit).
- Le stub génère un score déterministe dérivé des features → reproductible.

### Pourquoi c'est important
Montre qu'on peut remplacer la “boîte de calcul” par une autre (plus décentralisée / vérifiée) tout en conservant les preuves (hash features + modelHash + rollingHash).
