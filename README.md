# dsh-agent-browser

Native [DSH](https://deepseek.ai) browser tools built on
[agent-browser](https://github.com/vercel-labs/agent-browser) — snapshot+ref
automation, batched actions, and a baked-in live viewport panel. See
[PLAN.md](./PLAN.md) for the design document this implementation follows.

> **Name note:** `dsh-browser` and `dsh-browser-control` on npm are UNRELATED
> packages by other authors (Playwright/Puppeteer-era browser tools). This
> project ships as `dsh-agent-browser`, `dsh-agent-browser-core` and
> `dsh-agent-browser-pi`.

## Install & use

> **CRITICAL — never declare `@deepseek-ai/*` as regular dependencies.** DSH
> guarantees one module instance per host package across the whole process via
> its `$DSH_HOME/profiles/node_modules` fallback links (see
> `healProfilesModuleFallback` in `dsh-app-boot`). Bundling a copy inside the
> plugin creates a second instance, and module-scoped symbols (e.g.
> `TOOL_RUNTIME_SCHEDULER` in `dsh-tools`) stop matching across the boundary —
> every tool dispatch then dies with
> `Cannot read properties of undefined (reading 'prepare')`. Host packages are
> declared as **optional peerDependencies** here and as devDependencies for
> local builds only; at runtime they resolve through the harness's shared
> links. This bit us on 2026-08-25: the 0.1.1 install materialized private
> copies of `@deepseek-ai/dsh-tools` + `@deepseek-ai/schemastery` into the live
> profile and killed all tool calls on freshly booted instances.
>
> **pnpm 11 build-script gate:** `agent-browser` ships a `postinstall` that
> fixes up its bundled native binary. pnpm ≥ 10 blocks dependency lifecycle
> scripts unless your project allows them, and `dsh plugin add` surfaces that
> as a hard error (`ERR_PNPM_IGNORED_BUILDS`). One-time fix, per dsh profile:
>
> ```bash
> printf '\nallowBuilds:\n  agent-browser: true\n' >> ~/.dsh/profiles/<profile>/pnpm-workspace.yaml
> ```
>
> then run the `dsh plugin add` command below again. (Interactive alternative:
> `cd ~/.dsh/profiles/<profile> && pnpm approve-builds`.) The script is
> redundant where binaries are bundled — we verified the CLI runs fine with
> scripts ignored — but the allowance is still required for the install to
> succeed under default policy.

```bash
# in any DSH profile (web GUI, TUI, headless):
dsh plugin --profile web add npm:dsh-agent-browser
# pi sessions:
pi install npm:dsh-agent-browser-pi
```

Then just ask the agent to use the browser ("open example.com and read the
heading"). The panel appears automatically when a session is live, in any of
three display modes (remembered per browser):

- **chip** — collapsed launcher button, bottom-right.
- **float** — the original small floating card.
- **sidebar** — Codex-style right sidebar: docked full-height, drag-resizable;
  the app's columns reflow around it (it reserves real layout space instead of
  covering the conversation), with a tab strip where every live session gets its
  own tab, and beneath it a
  strip of the active session's *browser* tabs (click to switch, `×` to close,
  `+` to open). Humans can also pop the view out to its own window or hold
  takeover to drive the page themselves.

`browser_eval` stays approval-gated unless the operator sets `allowEval: true`.

## Live-profile installation — awaiting operator go-ahead

Installing into the running `~/.dsh/profiles/web` was deliberately **not** done
from this session (it needs a write outside the workspace plus your consent, and
activation requires a GUI restart anyway). When you're ready:

```bash
# Option A — dev link to this checkout (auto-picks rebuilds here):
dsh plugin --profile web add $HOME/dev/dsh-browser-control/packages/dsh-agent-browser

# Option B — published version once on npm:
dsh plugin --profile web add dsh-agent-browser
```

Then restart the DSH web profile; ask the agent to open a page and the panel
appears. Removing it later is `dsh plugin --profile web remove dsh-agent-browser`
(reconciler drops the bundle; tracked daemons are stopped on next boot).

## Publish artifacts — verified

Tarball consumption was validated end-to-end (not just source-dir installs):
packed all three packages, installed the adapter **tgz** into a fresh throwaway
profile (core resolved via a workspace override standing in for the registry),
and confirmed reconcile → composed config layer → 9 tools load from the
installed artifact → `require.resolve("dsh-agent-browser/client")` hits
`client/dist/client.js`. Tarball contents audited: no intermediates, types +
LICENSE + patch manifest present.

## Architecture

```
        DSH session (model)                         Human in the web GUI
              │                                             │
   browser_* tools (9)                            shell.overlay panel
              │                                             │
              │            dsh-agent-browser bundle        │
              ├── CLI/JSON subprocess ──┐                  │
              │   (agent-browser bin)   │                  │
              │                        ▼                  ▼
              │              daemon per session    same-origin HTTP/WS
              │              (Chrome + CDP)        /browser/sessions · /browser/stream
              │                                        │        │
              └── registry tracks handles ◄────────────┘        │
                  (labels, idle reaper, events)                 ▼
                                                        JPEG frames + console feed
                                                        (input only while takeover held)
```

Model traffic never touches raw ports; humans see pixels through one origin-gated
WebSocket. Subagents pass distinct `session` names for isolation.

## Packages

| Package | Status | Role |
|---|---|---|
| `packages/dsh-agent-browser-core` | **implemented, tested** | Host-agnostic driver: module-relative binary resolution, JSON envelope parsing, batch-over-stdin, session registry, live WS stream client with ack pacing, daemon health/recovery helpers. Zero host dependencies; declares `agent-browser@0.34.0` pinned. |
| `packages/dsh-agent-browser` | **server half live-verified, client built** | DSH bundle (`dsh.bundle.patch`): 9 model tools, prompt ladder, cookies redaction, eval gate, WS stream proxy + inventory + pop-out viewer routes. Client half contributes the overlay panel via `shell.overlay`; bundle format verified against the module-loader contract. **Proxy proven end-to-end against a real Chrome daemon (JPEG frames flow).** |
| `packages/dsh-agent-browser-pi` | **implemented, typechecked** | pi extension (extensions/browser.ts): same tool surface over the shared core; dashboard-URL hint for viewing. |

## Verified against reality (not just written)

- agent-browser 0.34.0 CLI/JSON contract captured from the shipped skill docs
  AND probed live: `{success,data,error}` envelopes, batch stdin
  array-of-arrays, `snapshot -i --json` refs map, screenshot-to-path,
  per-session stream sidecar (`<session>.stream` holds the port), WS frame
  protocol (`frame/status/tabs/url/console`, base64 JPEG, ack pacing).
- Core driver test-suite: 32 vitest tests over a mock CLI fixture covering
  envelope parsing, failure classification (`tab_gone`, stale refs),
  timeouts/kills, batch bail semantics, lifecycle stripping, session facade,
  registry events, binary resolution, stream port discovery.
- Compiled core smoke-tested against a REAL Chrome session on macOS
  (single call, 2-step batch in one round-trip, port discovery).
- DSH bundle conventions verified in the dsh source: `dsh.bundle.patch`
  reconciliation into `dsh.profile.bundles`, loader patch rows
  (`insert: [{id, name, config}]`), `defineTool` + `ctx.tools.register`,
  `ctx.systemPrompt.section`, `ctx.effect` disposal, webserver
  `register/registerUpgrade` routes, and the `shell.overlay` +
  `conversation.session.header.utilities` additive slots for the future panel UI.

## Development

```bash
pnpm install          # workspace bootstrap (approve esbuild + agent-browser builds)
pnpm build            # tsc across packages
pnpm test             # vitest (core package)
```

### Sandbox note

Chrome's own process sandbox cannot initialize under seatbelt-style file
sandboxes ("sandbox initialization failed"). When running inside such an
environment, pass launch args through the bundle config:

```yaml
- id: browser
  config:
    launchArgs: --no-sandbox,--disable-crashpad
```

## Install (target UX)

```bash
dsh plugin --profile web add dsh-agent-browser        # GUI surface
dsh plugin --profile headless add dsh-agent-browser   # headless runs
```

The plugin command forwards to pnpm, then auto-reconciles the bundle layer:
any dependency whose manifest declares `dsh.bundle` joins the profile stack,
no manual config edits. Config afterwards is optional via
`~/.dsh/profiles/<name>/cordis.patch.yml`.

## Verification log

- Core driver: 36 vitest tests (hermetic, mock CLI fixture) — green.
- Live spike: real daemon, single call / batch-in-one-round-trip / refs / screenshot / stream port discovery.
- Panel proxy LIVE check (`scripts/live-panel-check.mjs`): HTTP inventory lists the tracked
  session with its discovered stream port; WS client received a real 15 KB JPEG frame
  relayed from the Chrome daemon through `/browser/stream`.
- Client bundle: parses as CJS factory; registers `{name:"shell.overlay", id:"browser-panel"}`
  via `ctx.slots.inject` → `ctx.slots.register`; component is a plain React function.
- Adapter routes + policy gates: 14 unit tests (inventory/viewer/takeover handlers,
  redaction both shapes, eval fail-closed/approved/allowed).
- **Correctness fix found by new policy tests**: `stripLifecycle` (and two inline
  spreads in the CLI client) silently converted EVERY array payload (cookies,
  console lines, tabs, batch step results) into integer-keyed objects.
  Fixed recursively; regression tests added; cookie redaction now proven
  end-to-end (`[redacted]` by default, raw values only with
  `cookiesRedacted: false`).
- Idle reaper implemented in `SessionRegistry` (options arg; hosts pass
  `idleTimeoutMs`) — closes handles untouched beyond the timeout, emits
  `closed`, unref'd timer, `dispose()` for teardown; covered by tests.
- **ALL 9 registered tools live-pass against real Chrome** in one sweep
  (`scripts/live-all-tools.mjs`) — open, snapshot, find, act (+ mini-snapshot),
  get, eval (allowEval), screenshot, tabs, session.
- **Real cookie-redaction bug found and fixed by the live sweep**: the daemon
  wraps cookies as `{cookies:[...]}`, so the old bare-array check skipped
  redaction on real daemons and raw values would have reached the model.
  New dual-shape helper (`src/cookies.ts`) + tests cover both shapes.
- **Human-takeover input loop proven END-TO-END through the proxy** against real
  Chrome: HTTP hold → WS `input=1` → `input_mouse mousePressed/mouseReleased`
  (device px) → real DOM click → page state change observed via `browser_get`.
  The daemon's exact contract (camelCase eventTypes, clickCount-on-press,
  modifiers bitfield, wheel deltas, keyDown/keyUp shape) was recovered from
  agent-browser's own dashboard source and implemented in the panel — snake_case
  guesses are silently ignored by the daemon.
- Console-feed data path proven live: `console.log` in the page reached the
  WS client through the proxy (`proxy-console-marker-42`).
- Idle reaper verified LIVE via its real timer: untouched throwaway session
  dropped + `closed` event within ~3s of a 1.2s idle timeout; other sessions untouched.
- pi adapter raised to FULL 9-tool parity (added find/eval/tabs on session APIs).
- §4 allowlist approvals implemented: off-list `browser_open` routes through
  the host's approval seam (`allowed-once` grants the domain for the session,
  merged into the daemon allowlist on next spawn); fail-closed without an answerer.
- §6 instrumentation shipped: per-tool call counters exposed as `metrics` in
  `/browser/sessions`; feeds the Code-Mode revisit trigger with data.
- **Bug #4 (found in a REAL profile boot)**: the panel routes raced the
  webserver service — apply ran before `ctx.webServer` existed and silently
  skipped mounting. Fixed with the patch DSL's own ordering key
  (`inject: [webServer]` on the insert row) plus a loud fallback error.
  A real isolated web instance on port 3092 then served
  `/browser/sessions` correctly on first boot.
- **Bug #5 (found live, by you!)**: both viewers gated incoming WebSocket
  data on `ArrayBuffer`, but the daemon sends every message as TEXT JSON
  (base64 JPEG inside) — so the canvas stayed dark while status showed
  "live". Node-side tests never caught it because they parse strings
  regardless of type. Fixed in panel + pop-out; server-side frame flow was
  proven healthy via an independent WS probe against a running instance.
- Publish-grade packaging verified: tarball install path exercised into a second
  throwaway profile; exports["./client"].types now actually exists
  (`client/index.d.ts`); intermediate raw.cjs no longer ships.
- Panel forwards pointer, keyboard, and wheel events when takeover is held.
- `SessionStream` hardened: reconnect attempts that ERROR (dead port) now count
  against the failure budget — previously a stream pointed at a vanished port
  would retry forever. 7 new hermetic tests (decode/ack, backoff, budget,
  user-close, sidecar port resolution).
- Live evidence captured: a real 7.5 KB JPEG frame pulled through
  `.scratch/live-frame.jpg` (SOI/EOI verified); `browser_find` verified live on
  example.com incl. its CHANGED link copy ("Learn more") — text, anchored-regex,
  and correct zero-matches for stale assumptions.
- Eval/takeover gates unit-tested: fail-closed without approval service,
  `allowed-once` grants pass, `allowEval` bypasses, cookies redact by default.
- `browser_act` changed-region mini-snapshot verified LIVE through the registered tool:
  open(example.com) → snapshot finds `e2` → act(click @e2) returns step outcome plus the
  compact post-action tree (`page`). Stale-ref attempts fail cleanly
  (`failedCount: 1`, no snapshot) exactly as designed.
- Sidebar mode shipped: the panel now has chip / float / **sidebar** display
  modes (persisted in localStorage). The sidebar docks full-height on the right,
  drag-resizes via its left edge, carries a session tab strip (one tab per live
  session, Codex-style) and a browser-tab strip for the active session backed by
  the new human-only `GET/POST /browser/tabs` routes (list/switch/close/new over
  the session facade — never model-callable; the model keeps its own
  `browser_tabs`). Tab lists also refresh live from the daemon's stream `tabs`
  messages; the pop-out viewer page gained the same strip. Auto-open now fires
  at most once per page load so an explicit close sticks. Sidebar reflow: the
  panel pads the AppFrame's right edge so the conversation column resizes
  instead of being covered. Frame lookup climbs from the panel root to the
  overlay layer's `data-shell-overlay` attribute and steps out one level — the
  naive parentElement chain stops at the slot renderer's display:contents
  anchor / the out-of-flow layer itself, whose padding cannot reflow anything
  (found live). Degrades to plain overlay behavior if the structure moves.
  Click-through fix: the collapsed chip keeps
  `pointer-events:none` on its root (so it never blocks the app), but the pill,
  action buttons, tab strips, and resize handle now opt back in explicitly —
  previously the inherited none made the launcher pill dead once the once-only
  auto-open stopped re-forcing the panel open every poll. 6 route/viewer tests
  added (19 adapter + 45 core green).
- M3 gates: `browser_eval` fails closed unless `allowEval: true`; otherwise it routes
  through the host's interactive approval seam (`ctx.approval.request`) and permits
  only an explicit `allowed-once`. Human takeover is config-gated
  (`allowTakeover`), toggled per session by a HUMAN via the panel button
  (`POST /browser/takeover`), never model-callable; WS input forwarding requires
  input=1 AND the per-session held flag. The panel viewer shows a live activity
  feed (console/url lines) under the canvas.

## Install lifecycle — verified end-to-end in an isolated DSH_HOME

Using a throwaway home (`DSH_HOME=.scratch/dsh-home`) so nothing touches a live profile:

1. `dsh plugin --profile browser-test add <pkg>` → pnpm install + **auto-reconcile**:
   `dsh-agent-browser` appended to `dsh.profile.bundles`.
2. `dsh --profile browser-test --dump-config` → composed tree contains the
   `# == dsh-agent-browser` layer with the `browser` row and its config defaults.
3. The installed artifact loads from the profile's own resolution context
   (`require("dsh-agent-browser")` inside the profile dir) and registers all 9 tools;
   the client bundle ships at `client/dist/client.js` behind `exports["./client"]`.
4. `dsh plugin … remove dsh-agent-browser` → reconciler drops it from bundles.

A full headless chat boot needs a model key, which this environment does not expose;
that final smoke is listed below under operator actions.

## Deferred pending operator action

- Installing the tarball into the live `~/.dsh/profiles/web` requires writing outside the
  session workspace (and a GUI reload). Command when ready:
  `dsh plugin --profile web add ./packages/dsh-agent-browser` (or a packed tarball path).
- M0's auth-mode matrix vs real logins needs human credentials; the scripted login+scrape
  exit criterion is otherwise met.
- Headless end-to-end chat task (`dsh --profile browser-test "…"`) once a DEEPSEEK_API_KEY
  is present in the launching environment.
- Real-GUI loading of the panel client half (same install step as above, plus reload).