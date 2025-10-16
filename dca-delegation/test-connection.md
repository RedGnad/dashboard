# Test de Connexion Wallet

## Étapes de Test

1. **Ouvrir l'application** : http://localhost:8787
2. **Cliquer sur "Connect Wallet"**
3. **Vérifier dans la console** :
   - Nombre de connecteurs disponibles
   - Détection d'Ethereum
   - Messages de debug lors du clic

## Points à Vérifier

### ✅ Ce qui devrait fonctionner :
- Modal s'ouvre ✅
- Connecteurs affichés (MetaMask + Injected)
- Détection d'Ethereum dans le debug

### 🔍 Si ça ne fonctionne pas :
- Vérifier que MetaMask est installé
- Ouvrir la console développeur (F12)
- Regarder les erreurs dans la console
- Vérifier que le réseau Monad Testnet est ajouté à MetaMask

## Configuration Monad Testnet dans MetaMask

```
Nom du réseau: Monad Testnet
RPC URL: https://monad-testnet.g.alchemy.com/v2/aTJRGO9wVfbt3feglwTpq
Chain ID: 10143
Symbole: MON
Explorateur: https://explorer.testnet.monad.xyz
```

## Prochaines Étapes

1. Tester la connexion MetaMask
2. Vérifier l'authentification (personal sign)
3. Tester l'initialisation des Smart Accounts
4. Valider la création de délégation
