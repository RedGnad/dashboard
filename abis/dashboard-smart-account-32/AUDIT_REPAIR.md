Audit Log Repair (2025-10-08)
================================

Summary
-------
Integrity verification of `data/delegations/audit.log` failed due to a divergence in the hash chain beginning at line 107 (1-based). A dedicated repair process reconstructed the `prevEntryHash` and `rollingHash` values from the last valid entry prior to divergence, producing a new file: `data/delegations/audit.repaired.log`.

Root Cause
----------
The original repair attempt incorrectly treated `prevEntryHash` as the keccak hash of the *raw prior JSON line*. Canonical verifier logic instead defines:

* lineHash = keccak256( JSON.stringify( entryWithoutRollingHash ) )
* prevEntryHash (for entry i) = lineHash(entry i-1) OR `0x` for the first chained entry
* rollingHash(i) =
  * lineHash(i) for the first chained entry
  * keccak256( concatHex( rollingHash(i-1), lineHash(i) ) ) thereafter

The incorrect assumption caused every recomputed `prevEntryHash` and thus every downstream `rollingHash` to differ.

Repair Procedure
----------------
1. Parsed all lines of the original `audit.log`.
2. Located earliest divergence by recomputing expected `prevEntryHash` using canonical logic.
3. Preserved all lines up to (divergenceIndex - 1) verbatim.
4. For each subsequent line:
   * Replaced `prevEntryHash` with the prior line's canonical lineHash.
   * Recomputed rolling hash per canonical formula (excluding `rollingHash` from the lineHash input).
5. Wrote results to `audit.repaired.log` without mutating the original file.
6. Verified repaired chain with `src/verify-audit-repaired.ts` (PASS).

Verification Output
-------------------
```
[verify-repaired] PASS lines= 113 finalRollingHash= 0x03155ab85a4d698d1331a0a1d1765031fd84d812354f7d5aa92cfc8f2996ef5b
```

Artifacts
---------
* Repaired file: `data/delegations/audit.repaired.log`
* Final rolling hash: `0x03155ab85a4d698d1331a0a1d1765031fd84d812354f7d5aa92cfc8f2996ef5b`
* Divergence started at original line: 107

Next Steps
----------
* Optionally archive original `audit.log` (e.g., `audit.original.corrupt.log`).
* Replace production reference with repaired file after stakeholder sign-off.
* Add automated guard: run verifier after every append; abort on mismatch.
* Expose an endpoint / UI badge comparing current rolling hash with expected canonical chain head.

Change Log
----------
* Added accurate canonical hashing to `repair-audit.ts` (exclude `rollingHash` from lineHash input; use prior lineHash for `prevEntryHash`).
* Regenerated repaired log and documented final rolling hash.
