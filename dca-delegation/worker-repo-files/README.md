# DCA Worker

Worker autonome pour l'exécution des stratégies DCA via Delegation Toolkit.

## Configuration

Ajouter ces secrets dans GitHub Actions :

- `VITE_RPC_URL`
- `VITE_ZERO_DEV_BUNDLER_RPC` 
- `VITE_ZERO_DEV_PAYMASTER_RPC`
- `VITE_DELEGATE_PRIVATE_KEY`

## Fonctionnement

- Le workflow s'exécute chaque minute
- Le worker lit `plan.json` pour déterminer s'il doit agir
- L'intervalle réel est contrôlé par `intervalSeconds` dans le plan
- Les mises à jour du plan sont commitées automatiquement

## Test local

```bash
npm install
npm start
```
