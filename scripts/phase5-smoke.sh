#!/usr/bin/env bash
# Simple Phase 5 smoke tests (EOA path) - requires jq & a running API on localhost:8787
# Usage: ./scripts/phase5-smoke.sh <delegator_eoa_lowercase>
set -euo pipefail
API="http://127.0.0.1:8787"
ADDR=${1:-}
if [[ -z "$ADDR" ]]; then
  echo "Usage: $0 <delegator_eoa_lowercase>" >&2
  exit 1
fi
if ! [[ $ADDR =~ ^0x[0-9a-f]{40}$ ]]; then
  echo "Invalid address format" >&2
  exit 1
fi

echo "[1] Hash preview (empty caveats)" >&2
HP=$(curl -s -X POST "$API/api/delegations/hash-preview" -H 'content-type: application/json' \
  -d '{"delegator":"'$ADDR'","delegate":"0x0000000000000000000000000000000000000a11","caveats":[],"salt":"0x01"}')
echo "$HP" | jq '.hashes.structHash,.warnings'

STRUCT=$(echo "$HP" | jq -r '.hashes.structHash')
if [[ -z "$STRUCT" || "$STRUCT" == "null" ]]; then
  echo "Struct hash not returned" >&2; exit 1; fi

echo "[2] Verify (should 404 before submit)" >&2
curl -s "$API/api/delegations/verify/$ADDR" | jq '.ok,.error'

echo "[NOTE] Remaining manual steps: build delegation, sign client side, submit, then rerun verify."
