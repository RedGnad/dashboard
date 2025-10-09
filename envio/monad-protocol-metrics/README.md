# Envio HyperIndex — Local Run (Option A)

This folder contains the schema/config/handlers for a Monad Testnet protocol metrics indexer.

We recommend generating a HyperIndex project via the Envio CLI using Contract Import or Local ABI for your actual contracts, then running it locally.

Docs referenced:
- Getting Started: https://docs.envio.dev/docs/HyperIndex/getting-started
- Contract Import: https://docs.envio.dev/docs/HyperIndex/contract-import
- Running Locally: https://docs.envio.dev/docs/HyperIndex/running-locally

## Prerequisites
- Docker Desktop running (local Hasura + services)
- Node.js + pnpm
- A Monad Testnet RPC (e.g. https://testnet-rpc.monad.xyz)

## Steps (Local)
1. Initialize a new HyperIndex project in a separate folder:
   - `pnpx envio init`
   - Choose `Contract Import` (if your contract is verified on a supported explorer) or `Local ABI` otherwise
   - If your chain is not listed in explorers, use `Local ABI` and set `Custom Network ID` to `10143` (Monad Testnet)
   - Enter your contract address (proxy address if applicable), e.g. `0xDf26B347a02e74cd8bf6F562454826CD49CC6CB1`
   - Select the events you want to index (pick events actually emitted by the contract)

2. Run the indexer locally:
   - `pnpm dev`
   - This will start Hasura locally and open the dashboard
   - Default local GraphQL: `http://localhost:8080/v1/graphql` (admin secret: `testing`)

3. Connect the backend API:
   - In this repo root, create a `.env` with:
     - `ENVIO_GRAPHQL_URL=http://localhost:8080/v1/graphql`
     - `ENVIO_HASURA_ADMIN_SECRET=testing` (if using the local default)
   - Restart the API and refresh the UI dashboard

4. Validate data flows:
   - Trigger on-chain activity that emits the selected events for your protocol
   - Check the `DailyMetrics` entity in Hasura
   - The UI `Protocol Metrics (Envio)` panel should now show non-zero stats

## Notes
- The files here (config.yaml, schema.graphql, src/EventHandlers.ts) illustrate an indexing-time aggregation pattern. You can adapt them into your generated project or evolve them as needed.
- For hosted deployments, see: https://docs.envio.dev/docs/HyperIndex/hosted-service

## Fetching ABI via BlockVision (Monad)
When the explorer UI doesn't expose ABI, you can use BlockVision's Monad Contract Source Code API to retrieve it.

Docs: https://docs.blockvision.org/reference/retrieve-contract-source-code

1) Set your API key in the backend `.env`:
   - `BLOCKVISION_API_KEY=...`

2) Use the helper script from repo root:
   - `npm run abi:blockvision -- 0xYourContractAddress [out.json]`

This saves the ABI JSON to `envio/abis/<address>.abi.json` (or the path you supply). Then, in Envio CLI, choose `Local ABI Import` and point to that file. Network = `Custom Network ID` 10143 (Monad Testnet), address = the same contract (proxy address if applicable), then select the events to index.
