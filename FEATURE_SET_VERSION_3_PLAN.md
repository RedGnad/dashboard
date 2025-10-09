# Feature Set Version 3 Plan (Draft)

Goal: Introduce additional experimental signals (e.g. momentumShortMinusLong, abnormalTransferFlag, quantizedPrice) into the hashed feature set while preserving backwards determinism for FEATURE_SET_VERSION <= 2.

## Current State (VERSION 2)
- Hashed ORDER: balanceStableRatio, balanceTargetRatio, allocationDeviation, timeSinceLastTradeMins, executionsLast24h, volatilitySimple.
- Dual hash publication: featureHash (legacy with timestamp) + featureHashV2 (stable without timestamp).
- momentumShortMinusLong is computed and exposed via API/UI but intentionally excluded from ORDER and hashes.
- Audit log `featuresCanonical` mirrors ORDER only.

## Proposed VERSION 3 Changes
1. Append new signals to ORDER (after existing entries) to preserve earlier position semantics:
   - momentumShortMinusLong
   - (optional) abnormalTransferFlag (if stabilized)
   - (optional) quantizedPrice (if needed as numeric feature vs separate meta)
2. Publish featureHashV3 (stable, no timestamp) while still emitting featureHash & featureHashV2 for replay comparability (grace period).
3. Upgrade path controlled by env FEATURE_SET_VERSION=3.
4. Add explicit migration test asserting:
   - FEATURE_SET_VERSION=2: momentum absent from ORDER.
   - FEATURE_SET_VERSION=3: momentum present and featureHashV3 differs when momentum value changes.
5. Maintain audit schema version bump only if storage layout (lines) changes materially; otherwise store new hashes alongside existing fields.

## Safety / Determinism Considerations
- Momentum uses only historical ai_decision lines; adding it to ORDER at v3 preserves replay determinism (no live snapshot dependency).
- Quantized price must reference the same snapshotPrice already recorded in audit lines to avoid forward-looking bias.
- abnormalTransferFlag derived from HyperIndex needs deterministic recomputation for a fixed audit subset; ensure aggregator uses chronological deterministic ordering (already enforced via eventSetHash test).

## Action Checklist
- [ ] Implement FEATURE_SET_VERSION=3 branch in `features.ts` adding new ORDER entries.
- [ ] Compute and emit featureHashV3.
- [ ] Extend audit append logic to include featureHashV3 & featureSchemaVersion update if needed.
- [ ] Add migration tests (similar to momentumHashIsolation) verifying momentum inclusion only at v3.
- [ ] Update documentation (README) with versioning semantics.

## Rollout Phases
1. Shadow (current): Expose momentum externally (preview/force) without hashing.
2. Dual (future PR): Introduce v3 code path behind env flag; keep default at 2.
3. Promote: Switch default FEATURE_SET_VERSION to 3 after sufficient monitoring.

---
This file is a lightweight roadmap; keep scope tight to avoid over‑design.
