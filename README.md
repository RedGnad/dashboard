# DCA Autonomous Wallet (Monad Testnet)

Minimal backend agent DCA using MetaMask Delegation Toolkit (v0.13) on Monad Testnet, with ERC-4337 userOperations and ERC-20 paymaster (ZeroDev/Pimlico compatible). Swaps USDC -> WMON (optional unwrap to MON) periodically without popups via off-chain delegations.

## Stack
- Node.js + TypeScript
- viem + @metamask/delegation-toolkit
- ERC-4337 BundlerClient + PaymasterClient (ZeroDev preferred; Pimlico fallback)
- Uniswap Universal Router for swaps

## Network
- Chain: Monad Testnet (chainId 10143)
- RPC: https://testnet-rpc.monad.xyz
- EntryPoint v0.7: 0x0000000071727De22E5E9d8BAf0edAc6f37da032
- Universal Router: 0x3ae6d8a282d67893e17aa70ebffb33ee5aa65893
- WMON: 0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701
- USDC (testnet): 0xf817257fed379853cDe0fa4F97AB987181B1E5Ea

## Env
Copy `.env.example` to `.env` and fill:
- RPC_URL
- ZERO_DEV_BUNDLER_RPC (or PIMLICO_BUNDLER_RPC)
- ZERO_DEV_PAYMASTER_RPC (or PIMLICO_PAYMASTER_RPC)
- DELEGATE_PRIVATE_KEY (agent signer)
- DCA_AMOUNT_USDC=1
- SLIPPAGE_BPS=100
- UNWRAP_TO_MON=true|false

## Run (dev)
- install deps
- run scheduler to execute every minute

Quick start:
- Copy .env.example to .env, fill RPC and ZeroDev URLs, and DELEGATE_PRIVATE_KEY test key.
- Start backend API (listens on :3000): npm start
- In another terminal, run the web app:
	- cd web && npm install && npm run dev
	- Open http://localhost:5173
	- Connect wallet, create & sign delegation, which posts to backend.
- Backend will detect delegations and can run a DCA userOperation.

## Notes
- Delegations are off-chain (ERC-7710) and attached to the userOperation during signing; no on-chain redeem necessary for 4337 Hybrid flow. Use Delegation Manager only if you opt into the on-chain redeem flow.
- Allowance management: approve USDC to Paymaster and Router when needed.
