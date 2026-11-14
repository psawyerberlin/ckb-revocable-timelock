# Decisions log (AI worker)

Newest spec first. One `##` section per spec, one bullet per decision: what was unspecified or contradictory,
what was chosen and why. Protocol-changing decisions are also proposed as a `SPEC.md` diff in the PR body
(`AIWORKER.md` §5).

## (no spec run yet)

- 2026-11-14 — maintainer: SPEC.md v0.2 (CSR edition) and the specs under `aiworker/` written; vectors in
  `spec/vectors/` generated with an independent Python implementation (blake2b-256 `ckb-default-hash`, GF(2^8)
  Shamir with polynomial 0x11b, JCS as `sort_keys` + compact separators for the integer/string subset).
