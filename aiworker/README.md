# AIWorker specs

The work is built by **AIWorker** (pswsl). Upload the files of `specs/` one project at a time, in this order. Each project
starts from the branch the previous one pushed, so the pull requests stack: merge them oldest first.

| Order | Upload | Starts from | Pushes to | Details in |
|---|---|---|---|---|
| 1 | `specs/crt-contracts.md` | `main` | `aiworker/crt-contracts` | `01-crt-contracts.md` |
| 2 | `specs/crt-service.md` | `main` (after merging 1) | `aiworker/crt-service` | `02-crt-service.md` |
| 3 | `specs/crt-client.md` | `main` (independent of 2) | `aiworker/crt-client` | `03-crt-client.md` |
| 4 | `specs/crt-web.md` | `aiworker/crt-client` | `aiworker/crt-web` | `04-crt-web.md` |
| 5 | `specs/crt-devnet-e2e.md` | `aiworker/crt-web` | `aiworker/crt-devnet-e2e` | `05-crt-devnet-e2e.md` |

Before the first upload (once, on pswsl): add this repository and its deploy key to AIWorker's allow-list under the key name
`ckb-revocable-timelock` (AIWorker guide, section 7a). If a project fails, fix the cause and re-queue it under a new project
name and a new `push.branch`; never reuse a branch.

Acceptance: `node --test acceptance/aiworker-<name>/` and, where present, `node acceptance/aiworker-<name>/named.mjs`,
from the repository root. The acceptance directories and `spec/vectors/` are protected.
