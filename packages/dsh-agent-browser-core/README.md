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
2. `AGENT_BROWSER_BIN` environment variable
3. `agent-browser` on `PATH`
4. the pinned `agent-browser` npm dependency bundled with this package

## Environment

Spawned daemons inherit a scrubbed environment; allowlists ride as
`AGENT_BROWSER_ALLOWED_DOMAINS` (config + interactive grants merged).

## License

MIT
