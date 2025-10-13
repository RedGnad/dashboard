# Envio HyperIndex: Protocol Metrics

This folder defines an Envio indexer that aggregates daily protocol metrics for:

- magma (StakeManager)
- ambient (AmbientCore)
- curvance (Curvance demo event)

It writes DailyMetrics(protocolId,dateISO,usersDaily,txDaily,txCumulative,avgTxPerUser) that our API reads.

## Files
- `config.yaml`: Networks, contracts, events, and handlers
- `schema.graphql`: Entities including DailyMetrics/DailyUser/ProtocolState
- `src/EventHandlers.ts`: Magma handlers
- `src/EventHandlers_Ambient.ts`: Ambient handlers (counting swaps/mints/burns)
- `src/EventHandlers_Curvance.ts`: Curvance handlers

## Local check

- Codegen once to ensure bindings and schema are valid:

```sh
cd envio/protocol-metrics
npx envio codegen
```

- Start locally (requires Postgres etc.; optional):

```sh
npx envio start -d .
```

## Hosted deploy

1. Push this folder to the repository connected to Envio Hosted project (the one backing your GraphQL `ENVIO_GRAPHQL_URL`).
2. In Envio dashboard, trigger a deploy or ensure auto-deploy on push is enabled.
3. After indexing catches up, verify in GraphiQL:

```graphql
query CheckDaily($ids: [String!], $date: String!) {
  DailyMetrics(where: {protocolId: {_in: $ids}, dateISO: {_eq: $date}}) {
    protocolId
    dateISO
    usersDaily
    txDaily
    txCumulative
    avgTxPerUser
  }
}
```

- Variables:

```json
{ "ids": ["magma","ambient","curvance"], "date": new Date().toISOString().slice(0,10) }
```

You should see rows for magma and curvance immediately if events exist. Ambient will populate as soon as relevant events are emitted and processed.

## Notes
- The Ambient event signatures in `config.yaml` match the ABI in `envio/abis/ambient-core.json`. If they change, update signatures accordingly.
- Our backend maps Envio `protocolId` values 1:1 (magma, ambient, curvance). If a different name is used on the Envio side, set `envioId` in the API registry.
