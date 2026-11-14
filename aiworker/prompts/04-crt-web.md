# AI worker run — the reference web client at crt.chainsolution.net/app

You are an autonomous coding agent working alone in the repository `psawyerberlin/ckb-revocable-timelock`. Nobody will answer questions;
decide, record, continue. Do not stop before every phase below is done or recorded as blocked.

## Start

1. `cd` into the repository root. Read, in this order and completely: `AIWORKER.md`, `SPEC.md`,
   `aiworker/04-crt-web.md`, `client/README.md`, `site/assets/site.css`, `site/index.html` (the site is the maintainer's; only `site/app/` is yours), then `DECISIONS.md` (a previous run may have left notes for you).
2. Create the branch `aiworker/crt-web` from the current `main` (if it exists already, continue on it).
3. Run the acceptance command once before writing any code, to see what is expected:

```sh
node --test acceptance/aiworker-crt-web/
node acceptance/aiworker-crt-web/named.mjs
```

## Do

Work through the phases of `aiworker/04-crt-web.md` in order:

1. Phase 1 — Vite shell, `base: '/app/'`, build copied into `site/app/`, network switch, CCC wallet.
2. Phase 2 — create flow: Deadline → **Settings (n, t, mandatory, heartbeat slider with presets and detection delay, tips, organiser fee; live cost panel from `estimateCost`)** → Runners → Quote (frozen estimate) → Create → Arm → Kit.
3. Phase 3 — My switches (status, headroom, Renew / Rewrap / Cancel / Reclaim; Cancel never smaller than Create) and Recover.
4. Phase 4 — tests (`web_cost_panel_live` among them), no external requests in the build, `docs/web.md`, CHANGELOG.

After each phase: quality gates of `AIWORKER.md` §3.4, the acceptance command above, a commit
(`type(scope): summary`), and a bullet per decision in `DECISIONS.md` under a `## crt-web` section (newest spec
first in the file).

## Rules that override everything else

- Protected paths (`AIWORKER.md` §3.2) are never edited: `acceptance/**`, `SPEC.md`, `AIWORKER.md`, `aiworker/**`
  and the others listed there. A test you disagree with is implemented as written and the disagreement is noted.
- No manual steps. Anything only a human can do goes into `docs/manual-steps.md` as exact commands, and you continue.
- No secrets, no funded keys, no tokens in the repository.
- Never fake a passing test. A blocked phase stays red and is explained in `DECISIONS.md`.
- Use the site's palette and type (`site/assets/site.css`); no UI framework, no fonts or scripts from a CDN.
- Mainnet stays disabled while `deployments/mainnet.json` has `"enabled": false`.

## Finish

Push the branch and open one pull request against `main` using `.github/pull_request_template.md`: phases done,
the acceptance output (last 30 lines), the `DECISIONS.md` section, and any `SPEC.md` change you propose as a
diff in the body. Then stop.
