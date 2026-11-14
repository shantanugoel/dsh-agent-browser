# dsh-agent-browser

Native browser automation for [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh):
nine `browser_*` model tools driving [agent-browser](https://github.com/vercel-labs/agent-browser)
(Chrome via CDP), plus a live-view panel baked into the DSH web GUI — watch the
page the agent is working on, hold human takeover, and drive it yourself.

Part of a three-package family:

| package | role |
| --- | --- |
| **dsh-agent-browser** | DSH plugin: tools + panel (you are here) |
| [dsh-agent-browser-core](https://www.npmjs.com/package/dsh-agent-browser-core) | daemon driver (JSON calls, streams, session registry) |
| [dsh-agent-browser-pi](https://www.npmjs.com/package/dsh-agent-browser-pi) | pi extension at full tool parity |

## Install

Requires Node 24.9+, DSH 0.2.2 or newer with the web profile, and Chrome.
Tested against DSH `0.2.2-rc.1` (host tools + web client panel).
`agent-browser@0.43.0` uses installed system Chrome automatically; if none is
present, run the profile's `agent-browser install` once to fetch Chrome for
Testing.

**pnpm ≥ 10 gates dependency build scripts.** `agent-browser` ships one
(`postinstall` materializes the host-platform native binary from the matching
`@agent-browser/cli-*` optional dependency), so first allow it in the profile
you are installing into — once per profile:

```bash
printf '\nallowBuilds:\n  agent-browser: true\n' >> ~/.dsh/profiles/web/pnpm-workspace.yaml
```

then:

```bash
dsh plugin --profile web add dsh-agent-browser
```

Restart the DSH web profile and ask the agent to open a page — the panel
appears automatically. If the add step fails with `ERR_PNPM_IGNORED_BUILDS`,
the allowance above was not applied to that profile's `pnpm-workspace.yaml`
(interactive alternative: `cd ~/.dsh/profiles/web && pnpm approve-builds`).

> Note: 0.43 ships the native binary in per-platform `@agent-browser/cli-*`
> optional dependencies instead of the main tarball, so tools still work
> where lifecycle scripts stay blocked: the launcher materializes and links
> the platform binary on first run. Keep optional dependencies enabled (an
> `--omit=optional` / `optional=false` install leaves no binary to link); the
> allowance exists to satisfy default supply-chain policy and prepare the
> binary eagerly during install.

Uninstall: `dsh plugin --profile web remove dsh-agent-browser`.

## Tools

`browser_open`, `browser_snapshot`, `browser_find`, `browser_act`,
`browser_get`, `browser_eval`, `browser_screenshot`, `browser_tabs`,
`browser_session` — snapshot-ref discipline throughout (`act` returns
per-step outcomes plus a changed-region mini-snapshot), cookies redacted by
default, `eval` routed through the host approval seam.

## Panel

Canvas live view over the daemon's JPEG stream (ack-paced), session picker,
pin/pop-out, activity feed (console + URL events), and an explicit human-
takeover toggle — takeover input never routes through the model.

## Configuration

Row id `browser` in your profile patch, e.g.:

```yaml
- id: browser
  config:
    headed: false
    idleTimeoutMinutes: 30
    allowedDomains: ["example.com", "internal.corp"]
    autoOpenPanel: true
```

Off-list domains can be granted interactively per session through the host
approval flow when the agent tries to open them.

## License

MIT
