# 🚀 SETUP FINAL - NE PLUS TOUCHER APRÈS

## Étape 1: Générer UNE clé définitive

```bash
node -e "import('viem').then(v => console.log('DELEGATE_PRIVATE_KEY=' + v.generatePrivateKey()))"
```

**⚠️ COPIE cette clé dans `.env` et NE LA CHANGE PLUS JAMAIS!**

## Étape 2: Vérifier le Delegate SA

```bash
curl -s http://localhost:8787/api/delegate | jq
```

Note l'adresse du Delegate SA. **C'est ton Delegate SA définitif.**

## Étape 3: Déployer le Delegate SA (si pas déjà fait)

Le Delegate SA se déploiera automatiquement au premier UserOp grâce au paymaster.

## Étape 4: Créer la delegation dans le frontend

1. Va sur http://localhost:5173
2. Connecte MetaMask
3. Clique "Créer Delegation"
4. Signe avec MetaMask

**⚠️ Ne recrée JAMAIS la delegation sauf si tu changes de Delegator SA!**

## Étape 5: Tester

Lance un DCA:
- Montant: 0.1 USDC
- Target: WMON

Si ça marche → **C'EST BON, NE TOUCHE PLUS À RIEN!**

## Problèmes courants

### "AA25 nonce error"
- **Cause:** Plusieurs UserOps en parallèle
- **Fix:** Le lock de concurrence est déjà implémenté, redémarre le backend

### "Invalid delegate 0x...0a11"
- **Cause:** Delegation mal formée
- **Fix:** Recrée la delegation dans le frontend

### "AA25 deployment error"
- **Cause:** Delegate SA pas encore déployé
- **Fix:** Attends 5 min que le déploiement se fasse

## Règles d'or

1. ✅ **NE JAMAIS changer DELEGATE_PRIVATE_KEY**
2. ✅ **NE JAMAIS supprimer les delegations** sauf si nécessaire
3. ✅ **Attendre la confirmation** avant d'envoyer un autre UserOp
4. ✅ **Utiliser le lock de concurrence** (déjà fait dans le code)
5. ✅ **Laisser le bundler estimer le gas** (déjà fait dans le code)

## État actuel du code

✅ Gas estimation automatique (server.ts + runner.ts)
✅ Lock de concurrence (runner.ts)
✅ Paymaster configuré (.env)
✅ Attente de confirmation (waitForUserOperationReceipt)

**Le code est PRÊT. Il faut juste un état propre.**
