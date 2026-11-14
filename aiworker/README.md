# AI worker specs

Read `../AIWORKER.md` first. Run the specs in numeric order; each names its branch and acceptance directory.

| # | Spec | Branch | Acceptance |
|---|---|---|---|
| 00 | `00-csr-random-bytes.md` (in the CSR repo) | `aiworker/csr-random-bytes` | `acceptance/aiworker-csr-random-bytes/` (copy to the CSR checkout) |
| 01 | `01-crt-contracts.md` | `aiworker/crt-contracts` | `acceptance/aiworker-crt-contracts/` |
| 02 | `02-crt-service.md` | `aiworker/crt-service` | `acceptance/aiworker-crt-service/` |
| 03 | `03-crt-client.md` | `aiworker/crt-client` | `acceptance/aiworker-crt-client/` |
| 04 | `04-crt-web.md` | `aiworker/crt-web` | `acceptance/aiworker-crt-web/` |
| 05 | `05-crt-devnet-e2e.md` | `aiworker/crt-devnet-e2e` | `acceptance/aiworker-crt-devnet-e2e/` |

Each acceptance directory is run with `node --test acceptance/aiworker-<name>/` and, where present,
`node acceptance/aiworker-<name>/named.mjs`, from the repository root.
