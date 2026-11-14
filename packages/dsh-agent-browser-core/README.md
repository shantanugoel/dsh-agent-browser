# dsh-agent-browser-core

Daemon driver for [agent-browser](https://github.com/vercel-labs/agent-browser)
used by [dsh-agent-browser](https://www.npmjs.com/package/dsh-agent-browser).
Speaks the CLI/JSON protocol directly (no MCP hop): typed calls with timeouts
and kill escalation, batch steps, snapshot refs, screenshots, the WebSocket
frame stream (ack pacing, reconnect budget, sidecar port discovery), a session
registry with an idle reaper, and runtime domain-grant merging for allowlisted
navigation.

Most users install the plugin package instead and never touch this directly.

## Binary resolution

The `agent-browser` binary is resolved in this order:

1. explicit `binaryPath` config
2. the pinned `agent-browser` package's `bin` entry (resolved from this
   package's dependency graph, never from `PATH`)
3. that package's platform-native `bin/agent-browser-<platform>-<arch>` file

0.43 ships the native binary inside per-platform `@agent-browser/cli-*`
optional packages; the pinned package's `bin/agent-browser.js` launcher finds
and runs the matching one. The order above is unchanged: the launcher always
wins, and the platform-native fallback is the file the postinstall (or the
launcher's first run, when install scripts are blocked) materializes into
`bin/`.

## Environment

This package pins `agent-browser@0.43.0`. Spawned daemons inherit a scrubbed
environment; allowlists ride as `AGENT_BROWSER_ALLOWED_DOMAINS` (config +
interactive grants merged).

0.42 replaced the old `AGENT_BROWSER_STATE_DIR` switch with namespaces and
moved daemon/stream sidecars into the socket directory. `defaultHostEnv()`
returns the supported isolation overrides for a DSH host:

```ts
import { defaultHostEnv } from "dsh-agent-browser-core";

const env = defaultHostEnv(); // stable AGENT_BROWSER_NAMESPACE + short AGENT_BROWSER_SOCKET_DIR
```

The namespace is derived from `DSH_HOME`, so different DSH homes do not share
daemon state. The short socket directory keeps session names inside the
104-byte Unix socket path limit.

## License

MIT
