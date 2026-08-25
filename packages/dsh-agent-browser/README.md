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

Requires Node 24+, a DSH checkout with the web profile, and Chrome.

**pnpm ≥ 10 gates dependency build scripts.** `agent-browser` ships one
(`postinstall` fixes up its bundled native binary), so first allow it in the
profile you are installing into — once per profile:

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

> Note: the binaries needed at runtime ship inside the `agent-browser`
> tarball, so tools work even where lifecycle scripts stay blocked; the
> allowance exists to satisfy default supply-chain policy during install.

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
