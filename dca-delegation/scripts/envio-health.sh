#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Load .env if present
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

SINCE=$(node -e 'd=new Date();d.setUTCHours(0,0,0,0);console.log(Math.floor(d.getTime()/1000))')
TOKENS='["0xe0590015a873bf326bd645c3e1266d4db41c4e6b","0x268e4e24e0051ec27b3d27a95977e71ce6875a05","0xa2426cd97583939e79cfc12ac6e9121e37d0904d","0xfe140e1dce99be9f4f15d657cd9b7bf622270c50","0xcf5a6076cfa32686c0df13abadA2b40dec133f1d","0x5387C85A4965769f6B0Df430638a1388493486F1"]'

ENDPOINTS=()
[ -n "${VITE_ENVIO_GRAPHQL_URL:-}" ] && ENDPOINTS+=("$VITE_ENVIO_GRAPHQL_URL")
[ -n "${VITE_ENVIO_GRAPHQL_URL_FAST:-}" ] && ENDPOINTS+=("$VITE_ENVIO_GRAPHQL_URL_FAST")
[ -n "${VITE_ENVIO_GRAPHQL_URL_PRECISE:-}" ] && ENDPOINTS+=("$VITE_ENVIO_GRAPHQL_URL_PRECISE")

if [ ${#ENDPOINTS[@]} -eq 0 ]; then
  echo "No Envio endpoints configured in .env" >&2
  exit 1
fi

for url in "${ENDPOINTS[@]}"; do
  echo "===== $url ====="
  # Swaps + Trades counts
  curl -s -X POST "$url" \
    -H 'Content-Type: application/json' \
    -d '{"query":"query Day($since:Int!){ SwapEvent(where:{blockTimestamp:{_gt:$since}}, limit:5000){ transactionHash } Kuru_Trade(where:{blockTimestamp:{_gt:$since}}, limit:5000){ transactionHash } }","variables":{"since":'$SINCE'}}' \
  | jq '.data | {swaps:(.SwapEvent|length), trades:(.Kuru_Trade|length)}'

  # Transfers counts on tracked tokens
  curl -s -X POST "$url" \
    -H 'Content-Type: application/json' \
    -d '{"query":"query DayTransfers($since:Int!,$tokens:[String!]){ TokenTransfer(where:{blockTimestamp:{_gt:$since}, tokenAddress:{_in:$tokens}}, limit:5000){ transactionHash } }","variables":{"since":'$SINCE',"tokens":'$TOKENS'}}' \
  | jq '.data | {transfers:(.TokenTransfer|length)}'

  # One sample record (if any)
  curl -s -X POST "$url" \
    -H 'Content-Type: application/json' \
    -d '{"query":"query Sample($since:Int!,$tokens:[String!]){ Kuru_Trade(where:{blockTimestamp:{_gt:$since}}, limit:1){ transactionHash blockTimestamp } TokenTransfer(where:{blockTimestamp:{_gt:$since}, tokenAddress:{_in:$tokens}}, limit:1){ transactionHash blockTimestamp tokenAddress } }","variables":{"since":'$SINCE',"tokens":'$TOKENS'}}' \
  | jq '.data'
done

echo "\nTip: To force a specific endpoint for ad-hoc tests, export VITE_ENVIO_GRAPHQL_URL to the FAST URL and retry."