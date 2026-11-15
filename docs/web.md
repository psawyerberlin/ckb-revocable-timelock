# CRT web app

The reference client served at `https://crt.chainsolution.net/app/`: a static single-page TypeScript app (Vite, no
framework, no server, no analytics, no external fonts or CDNs). It uses `@crt/client` and CCC wallet connectors (JoyID
first, then any EIP-6963 browser wallet).

## Layout

- `web/src/` — shell and wallet (`shell.ts`, `wallet.ts`), create flow (`create.ts`, `flow.ts`, `draft.ts`), My switches
  (`manage.ts`, `switches.ts`), Recover (`recover.ts`), pure helpers (`quote.ts`, `risk.ts`, `coalition.ts`).
- Routes are hash based: `#/create/<deadline|runners|quote|create|arm|kit>`, `#/switches`, `#/recover`.
- `base` is `/app/`; `npm run build` builds into `web/dist/` and copies it to `site/app/` so `site/` is the one deploy root.

## Network

Testnet and mainnet are selectable; mainnet stays disabled with "CRT is on testnet until CSR's service runtime opens on
mainnet" while `deployments/mainnet.json` has `"enabled": false`. Optional build-time setting:
`VITE_CRT_ORGANISER_ADDRESS` (without it the organiser fee must be 0).

## Develop and test

```sh
cd web
npm ci
npm run dev        # Vite dev server
npm run build      # typecheck, build, copy to ../site/app
npm test           # vitest (jsdom) + external-reference check of dist/
```

Tests (`web/test/`) use `vitest` with `jsdom` and `@testing-library/dom`; Playwright is not used (no browser offline).
They cover: every create-flow screen renders, Cancel reachable in two clicks from My switches (open, confirm) and styled
as large as Create, the mainnet-disabled text, and the quote (`estimateCost`: about 1 530 CKB spent, 4 440 locked for the
defaults, ±2 %) changing when the heartbeat slider moves. `scripts/check-external.mjs` greps `dist/` for `http(s)://`
hosts other than the RPC, monitor, wallet and namespace hosts it allows.

## Not covered

Nothing here runs against a live chain; wallet signing, broadcast and Node Cell reads are checked by typecheck and the
client's own tests only, and are exercised manually on testnet.
