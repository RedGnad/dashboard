# DCA Delegation - Monad Testnet

Application de DCA (Dollar Cost Averaging) automatisé utilisant la délégation MetaMask sur Monad Testnet. Permet d'effectuer des swaps USDC → WMON récurrents via des Smart Accounts et des délégations sécurisées.

## 🚀 Fonctionnalités

- **Connexion MetaMask** avec signature personnelle pour l'authentification
- **Smart Accounts** (délégant et délégué) créés et déployés automatiquement
- **Délégation sécurisée** avec permissions strictes (approve, swap, unwrap uniquement)
- **DCA automatisé** avec exécution immédiate au démarrage
- **Scheduler configurable** (intervalle, montant, slippage)
- **Actions manuelles** : Run Now, Unwrap WMON → MON
- **Monitoring en temps réel** : statut, prochaine exécution, hash UserOp, erreurs
- **UI moderne** inspirée de guardian-main (glassmorphism, dégradés violet/bleu)

## 🛠 Stack Technique

- **Frontend** : React 19 + TypeScript + Vite
- **Blockchain** : Viem + Wagmi + MetaMask Delegation Toolkit
- **Account Abstraction** : ZeroDev (Bundler/Paymaster)
- **Styling** : Tailwind CSS + Framer Motion
- **Réseau** : Monad Testnet (Chain ID: 10143)

## 📦 Installation

```bash
# Installer les dépendances
npm install

# Configurer les variables d'environnement
cp .env.example .env.local
# Puis éditer .env.local avec vos clés

# Lancer le serveur de développement
npm run dev
```

## 🔧 Configuration

### Variables d'environnement (.env.local)

```bash
# Monad Testnet
VITE_RPC_URL=https://monad-testnet.g.alchemy.com/v2/YOUR_KEY
VITE_ZERO_DEV_BUNDLER_RPC=https://rpc.zerodev.app/api/v3/YOUR_PROJECT_ID/chain/10143
VITE_ZERO_DEV_PAYMASTER_RPC=https://rpc.zerodev.app/api/v3/YOUR_PROJECT_ID/chain/10143

# Délégation
VITE_DELEGATE_PRIVATE_KEY=0x...
VITE_PAYMASTER_ADDRESS=0x...

# Optionnel
VITE_AI_ENABLED=false
```

### Adresses des contrats (Monad Testnet)

- **USDC** : `0xf817257fed379853cDe0fa4F97AB987181B1E5Ea` (6 decimals)
- **WMON** : `0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701` (18 decimals)
- **Uniswap V2 Router** : `0xfb8e1c3b833f9e67a71c859a132cf783b645e436`

## 🎯 Architecture

### Smart Accounts
- **Délégant** : Smart Account de l'utilisateur (créé via MetaMask)
- **Délégué** : Smart Account automatisé (clé privée configurée)

### Délégation
- **Scope** : `functionCall` avec cibles et sélecteurs stricts
- **Permissions** : 
  - `USDC.approve(address,uint256)`
  - `router.swapExactTokensForTokens(...)`
  - `WMON.withdraw(uint256)`

### Flux DCA
1. Utilisateur connecte MetaMask + signe l'authentification
2. Création/déploiement automatique des Smart Accounts
3. Création de la délégation avec permissions minimales
4. "Start DCA" → exécution immédiate + scheduler
5. Exécutions récurrentes via UserOperations délégués

## 🚦 Utilisation

1. **Connecter MetaMask** sur Monad Testnet
2. **Signer le message** d'authentification
3. **Attendre l'initialisation** des Smart Accounts
4. **Configurer le DCA** (montant USDC, slippage, intervalle)
5. **Start DCA** pour lancer avec exécution immédiate
6. **Monitorer** l'activité et les balances
7. **Unwrap** WMON → MON quand souhaité

## 📋 Scripts

```bash
npm run dev      # Serveur de développement (port 8787)
npm run build    # Build de production
npm run preview  # Prévisualisation du build
npm run lint     # Linter ESLint
```

## 🔮 Extensions futures

- **IA** : Modulation intelligente des montants/intervalles
- **Prix** : Intégration Envio GraphQL + Switchboard
- **3D** : Effets visuels avancés (WebGL/OGL)
- **Multi-tokens** : Support d'autres paires de trading

## 🛡 Sécurité

- Délégation avec permissions strictes (fonction call scope)
- Smart Accounts déployés on-chain avant utilisation
- Authentification par signature personnelle
- Variables sensibles via variables d'environnement
