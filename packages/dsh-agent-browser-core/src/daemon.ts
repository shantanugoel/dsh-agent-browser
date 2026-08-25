/**
 * Daemon lifecycle helpers. The agent-browser daemon boots lazily on the
 * first command of a session and idles out on its own (default 1h, tuned via
 * AGENT_BROWSER_IDLE_TIMEOUT_MS which {@link buildChildEnv} forwards), so this
 * layer only adds: health probes, one-shot stale-daemon recovery, and explicit
 * stop/close verbs.
 *
 * @module dsh-agent-browser-core/daemon
 */

import type { AgentBrowserClient } from "./client.ts";
import { BrowserDriverError } from "./errors.ts";

/** Outcome of a health probe. */
export type DaemonHealth =
  | { state: "running"; detail?: string }
  | { state: "stopped" }
  | { state: "unreachable"; error: string };

/** Probe whether the session's daemon answers commands right now. */
export async function probe(client: AgentBrowserClient, session?: string): Promise<DaemonHealth> {
  try {
    await client.call(["get", "url"], {
      session,
      timeoutMs: 15_000,
      // A probe must never pass launch args: it exists to check liveness.
      includeLaunchArgs: false,
    });
    return { state: "running" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/failed to connect|socket|ENOENT|ECONNREFUSED/i.test(message)) return { state: "stopped" };
    if (/timed out/i.test(message)) return { state: "unreachable", error: message };
    return { state: "unreachable", error: message };
  }
}

/**
 * Ensure the daemon is usable, recovering once from a stale/unresponsive
 * daemon by asking it to close first (which also clears pid/socket sidecars)
 * and letting the next command boot a fresh process.
 *
 * @returns "already-running" | "recovered" | "started".
 */
export async function ensureHealthy(
  client: AgentBrowserClient,
  session?: string,
  opts: { timeoutMs?: number } = {},
): Promise<"already-running" | "recovered" | "started"> {
  const health = await probe(client, session);
  if (health.state === "running") return "already-running";
  if (health.state === "unreachable") {
    // Best-effort teardown; ignore failure — the next spawn reboots anyway.
    await client
      .call(["close"], { session, timeoutMs: opts.timeoutMs ?? 20_000, includeLaunchArgs: false })
      .catch(() => undefined);
    return "recovered";
  }
  // stopped → boot it now with a cheap command so launch args apply here.
  await client.call(["open"], { session, timeoutMs: opts.timeoutMs ?? 60_000 });
  return "started";
}

/** Gracefully close one session's browser+daemon. */
export async function stopSession(client: AgentBrowserClient, session?: string): Promise<void> {
  const res = await client.call(["close"], { session, timeoutMs: 30_000, includeLaunchArgs: false }).catch(
    (err: unknown) => undefined,
  );
  void res;
}

/**
 * Close every session in the client's state dir (`close --all`).
 * Prefer {@link SessionRegistry.closeAll} from hosts — this is a last-resort
 * broom for one isolated state directory, not a machine-wide kill.
 */
export async function stopAllSessions(client: AgentBrowserClient): Promise<void> {
  await client.call(["close", "--all"], { timeoutMs: 60_000, includeLaunchArgs: false }).catch(() => undefined);
}

/**
 * List live sessions as reported by the daemon registry.
 * @throws {BrowserDriverError} when the listing cannot be read.
 */
export async function listSessions(client: AgentBrowserClient): Promise<Array<Record<string, unknown>>> {
  const res = await client.call<{ sessions?: Array<Record<string, unknown>> }>(["session", "list"], {
    timeoutMs: 20_000,
    includeLaunchArgs: false,
  });
  return res.data.sessions ?? [];
}
