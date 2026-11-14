# AI worker run — the CRT client library (`@crt/client`)

You are an autonomous coding agent working alone in the repository `psawyerberlin/ckb-revocable-timelock`. Nobody will answer questions;
decide, record, continue. Do not stop before every phase below is done or recorded as blocked.

## Start

1. `cd` into the repository root. Read, in this order and completely: `AIWORKER.md`, `SPEC.md`,
   `aiworker/03-crt-client.md`, `spec/vectors/*.json`, `docs/developers.md`, and in `../ckb-service-runner`: `sdk/js/csr-job.mjs`, `sdk/js/README.md`, `spec/job-cell-standard.md`, `spec/registry.md` §2, `docs/integrating-an-app.md`, then `DECISIONS.md` (a previous run may have left notes for you).
2. Create the branch `aiworker/crt-client` from the current `main` (if it exists already, continue on it).
3. Run the acceptance command once before writing any code, to see what is expected:

```sh
node --test acceptance/aiworker-crt-client/
node acceptance/aiworker-crt-client/named.mjs
```

## Do

Work through the phases of `aiworker/03-crt-client.md` in order:

1. Phase 1 — `client/src/core/`: hash + JCS, Shamir, envelope `CRT-ENV-v1`, access trees + headroom, cell layouts, payload, **`cost.ts` (`estimateCost`, `validateSwitchParams`, SPEC §6.2 and §11.1)**; vectors and KATs.
2. Phase 2 — `client/src/chain/`: JSON-RPC, deployment loader + `crtServiceId`, runners (RegistryV3 decoder + monitor API + runner list, with min tip / max heartbeat filters), `readSwitch`, hard-fail `verifyNodes`.
3. Phase 3 — `client/src/tx/`: CCC builders for Create (with `SwitchParams`), Arm, Renew, Rewrap, Cancel (no fee output), Reclaim; mocked-RPC tests.
4. Phase 4 — descriptor + schema, `wrapKey`/`unwrapAll`, kit generator (deterministic, self-contained, < 400 KB, `window.CRT_KIT.api`, `#crt-application`), recovery online and offline.
5. Phase 5 — CLI `crt`, `client/README.md`, `docs/developers.md` walkthrough with real code, CHANGELOG.

After each phase: quality gates of `AIWORKER.md` §3.4, the acceptance command above, a commit
(`type(scope): summary`), and a bullet per decision in `DECISIONS.md` under a `## crt-client` section (newest spec
first in the file).

## Rules that override everything else

- Protected paths (`AIWORKER.md` §3.2) are never edited: `acceptance/**`, `SPEC.md`, `AIWORKER.md`, `aiworker/**`
  and the others listed there. A test you disagree with is implemented as written and the disagreement is noted.
- No manual steps. Anything only a human can do goes into `docs/manual-steps.md` as exact commands, and you continue.
- No secrets, no funded keys, no tokens in the repository.
- Never fake a passing test. A blocked phase stays red and is explained in `DECISIONS.md`.
- Vendor `csr-job.mjs` once from a CSR tag, write `client/vendor/csr-job.sha256`, and add the tag as a header comment.
- The acceptance script greps the test output for the fixed test names: name them exactly.
- No override of any verification rule may exist in the source; a test greps for it.

## Finish

Push the branch and open one pull request against `main` using `.github/pull_request_template.md`: phases done,
the acceptance output (last 30 lines), the `DECISIONS.md` section, and any `SPEC.md` change you propose as a
diff in the body. Then stop.
