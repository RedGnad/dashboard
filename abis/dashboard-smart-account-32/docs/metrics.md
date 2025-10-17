# Protocol Metrics Modes

The backend endpoint `/api/metrics/protocols/daily` supports two data sources:

- Envio HyperIndex GraphQL (preferred) — set `ENVIO_GRAPHQL_URL` (and `ENVIO_HASURA_ADMIN_SECRET` if using local default `testing`).
- RPC quick-scan fallback — automatically used when Envio is not configured or unreachable.

## Behavior
- By default, if Envio is configured and reachable, results are fetched from GraphQL.
- If Envio is missing or returns an error, the server falls back to a lightweight RPC scan over a recent time window (default 6h), returning approximate daily stats per protocol.

## Controls
- Env var: `METRICS_RPC_FALLBACK_ONLY=true` forces RPC mode even if Envio is configured.
- Query params:
  - `hours=6` to adjust the scan window (1..168)
  - `withFees=true` to compute an average fee estimate (slower)

## Caveats
- RPC mode does not compute cumulative totals and may be less accurate for large windows.
- For full fidelity and historical aggregates, prefer running Envio locally (`npx envio start`) or point to a hosted HyperIndex endpoint.

## Oracles interplay (note)
- When `ENABLE_SWITCHBOARD=1`, spot price inputs for feature computation (v3 `priceQuantized`) should come from Switchboard (Surge) with deterministic quantization (6 decimals).
- If the oracle is unavailable or stale beyond `SWITCHBOARD_STALE_MS`, the backend falls back to a deterministic synthetic provider; this is visible in meta and should be considered in metrics interpretation.

See `INFERENCE_ORACLES.md` for the broader plan and invariants.
