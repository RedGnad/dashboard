# Guide des Délégations DCA

## Délégation créée avec succès ✅

Une délégation de test a été créée avec toutes les autorisations nécessaires pour éviter l'erreur **"AllowedTargetsEnforcer:target-address-not-allowed"**.

### 📋 Résumé de la délégation

- **Delegator SA** : `0xc2DD1c6b3911A05e0424Ff2E590832535F0d380E`
- **Delegate SA** : `0x3Da2eb75610076829822664D7FE01bC2a1750207`
- **User EOA** : `0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A`
- **Delegate EOA** : `0x3d688A94B373B611BC00A2CB206b831FcE7dF363`

### 🎯 Cibles autorisées

1. **USDC** : `0xf817257fed379853cDe0fa4F97AB987181B1E5Ea`
2. **Uniswap Router** : `0xfb8e1c3b833f9e67a71c859a132cf783b645e436`
3. **WMON** : `0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701`
4. **User SA** : `0xc2DD1c6b3911A05e0424Ff2E590832535F0d380E` (pour recevoir)
5. **User EOA** : `0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A` (pour transferts natifs)

### ⚡ Fonctions autorisées

- `approve(address,uint256)` - Approuver les tokens
- `transfer(address,uint256)` - Transférer les tokens
- `transferFrom(address,address,uint256)` - Transférer depuis
- `swapExactTokensForTokens(...)` - Swap Uniswap
- `withdraw(uint256)` - Retirer WMON → MON
- `deposit()` - Déposer MON → WMON
- `permit(...)` - EIP-2612 Permit
- `transferWithAuthorization(...)` - EIP-3009

## 🚀 Utilisation

### 1. Créer une nouvelle délégation

```bash
npm run create:delegation
```

### 2. Vérifier la délégation créée

```bash
ls -la data/delegations/
cat data/delegations/0xc2dd1c6b3911a05e0424ff2e590832535f0d380e.json
```

### 3. Tester avec un runner

La délégation est maintenant prête à être utilisée avec un backend DCA qui :
- Lit le fichier de délégation
- Exécute les swaps USDC → WMON
- Unwrap WMON → MON si configuré

## 🔧 Prochaines étapes

1. **Déployer le Smart Account utilisateur** sur Monad Testnet
2. **Envoyer des USDC de test** au SA utilisateur
3. **Configurer le backend** pour utiliser cette délégation
4. **Lancer le DCA automatique**

## 📝 Fichier de délégation

Le fichier généré contient :
- La délégation signée avec tous les caveats
- La configuration du job DCA
- Les paramètres d'exécution (montant, slippage, etc.)

## ⚠️ Important

- Cette délégation utilise des clés de test
- Pour la production, utilisez de vraies clés utilisateur
- Vérifiez que tous les contrats sont déployés sur Monad Testnet
- Testez avec de petits montants d'abord

## 🛠️ Scripts disponibles

- `npm run create:delegation` - Créer une nouvelle délégation
- `npm run dev` - Lancer l'interface utilisateur
- `npm run deploy:delegate` - Déployer le Smart Account délégué

## 🔍 Debugging

Si vous rencontrez encore l'erreur "target-address-not-allowed" :
1. Vérifiez que la bonne délégation est utilisée
2. Confirmez que toutes les adresses cibles sont listées
3. Vérifiez que les sélecteurs de fonction sont corrects
4. Assurez-vous que le Smart Account est déployé
