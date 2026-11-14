# AI worker run — CSR `random_bytes` host call (7050)

You are an autonomous coding agent working alone in the repository `ckb-service-runner/ckb-service-runner (your checkout at ../ckb-service-runner; the spec and the acceptance directory come from psawyerberlin/ckb-revocable-timelock)`. Nobody will answer questions;
decide, record, continue. Do not stop before every phase below is done or recorded as blocked.

## Start

1. `cd` into the repository root. Read, in this order and completely: `AIWORKER.md`, `SPEC.md`,
   `aiworker/00-csr-random-bytes.md`, `spec/host-interface.md`, `runner/src/runtime/host.rs`, `services/rust/csr-svc/src/lib.rs`, `docs/decisions.md` (the sections of earlier aiworker runs show the house style), then `DECISIONS.md` (a previous run may have left notes for you).
2. Create the branch `aiworker/csr-random-bytes` from the current `main` (if it exists already, continue on it).
3. Run the acceptance command once before writing any code, to see what is expected:

```sh
node --test acceptance/aiworker-csr-random-bytes/
node acceptance/aiworker-csr-random-bytes/named.mjs
```

## Do

Work through the phases of `aiworker/00-csr-random-bytes.md` in order:

1. Phase 1 — the host call: syscall 7050 in `runner/src/runtime/host.rs`, codes 0 / 11 / 12, available in local mode, cycle cost like every syscall, never logged; spec, RFC table, open questions and CHANGELOG updated.
2. Phase 2 — `services/rust/randtest` + manifest + workspace entry; runner integration test; `docs/testing.md`, README sentence.

After each phase: quality gates of `AIWORKER.md` §3.4, the acceptance command above, a commit
(`type(scope): summary`), and a bullet per decision in `DECISIONS.md` under a `## csr-random-bytes` section (newest spec
first in the file).

## Rules that override everything else

- Protected paths (`AIWORKER.md` §3.2) are never edited: `acceptance/**`, `SPEC.md`, `AIWORKER.md`, `aiworker/**`
  and the others listed there. A test you disagree with is implemented as written and the disagreement is noted.
- No manual steps. Anything only a human can do goes into `docs/manual-steps.md` as exact commands, and you continue.
- No secrets, no funded keys, no tokens in the repository.
- Never fake a passing test. A blocked phase stays red and is explained in `DECISIONS.md`.
- Before step 1, copy `acceptance/aiworker-csr-random-bytes/` and `acceptance/aiworker-csr-random-bytes.js` from the CRT repository into the CSR checkout; they are protected there too.
- Name the Rust tests exactly as `named.mjs` expects (`random_bytes_fills_len`, `random_bytes_len_zero_is_12`, `random_bytes_len_over_1024_is_11`, `random_bytes_local_mode_works`, `random_bytes_never_in_debug`, `randtest_two_draws_differ`).
- `DECISIONS.md` is the root file of the CSR repository (same convention), plus a short section in `docs/decisions.md`.

## Finish

Push the branch and open one pull request against `main` using `.github/pull_request_template.md`: phases done,
the acceptance output (last 30 lines), the `DECISIONS.md` section, and any `SPEC.md` change you propose as a
diff in the body. Then stop.
