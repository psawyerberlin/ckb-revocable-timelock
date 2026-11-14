# Spec 04 — reference web client (`crt-web`)

**Branch:** `aiworker/crt-web`. **Acceptance:** `acceptance/aiworker-crt-web/`.
**Depends on:** spec 03. **Normative:** `SPEC.md` §6, §8, §9, §10, §11.

The explainer site under `site/` is written by the maintainer and is **not** touched by this spec except for the
single link target `/app/`. This spec builds the application that lives at `https://crt.chainsolution.net/app/`:
a static, single-page TypeScript app (Vite, no server, no analytics, no external fonts or CDNs) using
`@crt/client` and CCC's wallet connectors (JoyID first, then any CCC signer).

## Phase 1 — shell and wallet

`web/` Vite project; `base: '/app/'`; output to `web/dist/`; `npm run build` copies `web/dist/` into
`site/app/` (so the whole site deploys as one static directory — `site/` is the deploy root). Network switch
testnet / mainnet (mainnet disabled with the text "CRT is on testnet until CSR's service runtime opens on
mainnet" while `deployments/mainnet.json` has `"enabled": false`). Wallet connect/disconnect with CCC; the
connected address and its CKB balance. Plain CSS, the palette and type of `site/assets/site.css` (import it), no
UI framework; keyboard-navigable; `prefers-color-scheme` respected.

## Phase 2 — create flow

Screens, in order, each one a route: **Deadline** (date picker; plain-language duration risk per `SPEC.md` §10;
the quantum disclaimer appears for > 5 years) →
**Runners** (directory table from `runners.ts`: rank, availability, country/ASN cell, stake, "unproven" badge,
switches served; coalition-risk summary of the current selection; "run your own runner" link to
`docs/operators.md`; the user picks `n` and `t`, optionally marks mandatory runners; `1-of-1` mandatory on a term
> 1 year requires typing "I understand") → **Quote** (`SPEC.md` §11 table instantiated: spent vs locked,
organiser fee shown as a separate line that can be set to 0) → **Create** (sign with the wallet, broadcast, show
`T`, wait for commits with a per-runner progress list reading the Node Cells) → **Arm** (descriptor built and
verified with hard-fail; MISMATCH shows the rule number and stops; sign Arm) → **Kit** (download
`crt-kit-<T8>.html`; "I have saved the kit" checkbox before leaving; optional "mirror to coordinator" switch,
off and greyed out in v0.1).

## Phase 3 — manage and recover

**My switches**: scan Node Cells whose `owner_lock_hash` is the connected wallet's lock hash (`get_cells` by lock
prefix is not possible on data — keep a local list in `localStorage` keyed by `T`, plus "add by T"). Per switch:
state, deadline, countdown in chain median time, both headroom figures, each runner's last heartbeat age,
buttons Renew / Rewrap / Cancel / Reclaim / Download kit again. **Cancel is one click plus one confirmation and is
never visually smaller than Create.**

**Recover** (no wallet needed): paste `T` or load a kit → read releases → shows which leaves released, computes
`K` when possible, offers download of `K` as hex and the "application slot" handover (`window.crtApplication`),
otherwise the headroom shortfall.

## Phase 4 — quality

`web/test/` with `vitest` + `@testing-library/dom` (or Playwright if available offline; record the choice):
screens render, Cancel reachable in ≤ 2 clicks from "My switches", mainnet disabled text, the quote matches
`estimateCost` for the defaults (1 530 spent, 4 440 locked ± 2 %) and changes when the heartbeat slider moves (`web_cost_panel_live`). Lighthouse-style checks
by script: no external requests in the built `site/app/` (grep `dist` for `https://` other than the configured
RPC/monitor URLs). `docs/web.md`, `CHANGELOG.md`.

## Acceptance

```sh
node --test acceptance/aiworker-crt-web/
node acceptance/aiworker-crt-web/named.mjs
```
