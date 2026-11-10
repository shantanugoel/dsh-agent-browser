/**
 * Child-process environment assembly. Daemons inherit a scrubbed copy of the
 * host environment: harness-specific variables never cross the boundary, and
 * obvious credential-shaped names are dropped. Computed agent-browser
 * overrides (idle timeout, allowlist) are appended last so they win.
 *
 * @module dsh-agent-browser-core/env
 */

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export interface EnvOverrides {
  /** Extra environment entries appended after scrubbing (highest precedence). */
  env?: Record<string, string>;
  /** Idle timeout forwarded to the daemon as AGENT_BROWSER_IDLE_TIMEOUT_MS. */
  idleTimeoutMs?: number;
  /** Domain allowlist forwarded as AGENT_BROWSER_ALLOWED_DOMAINS (comma-separated). */
  allowedDomains?: readonly string[];
}

/** Keys never forwarded to spawned browser processes. */
const DENY_PATTERNS: RegExp[] = [
  /^DSH_/i,
  /(?:^|_)API_KEY$/i,
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)/i,
];

/** Whether one environment key is denied forwarding. */
function denied(key: string): boolean {
  return DENY_PATTERNS.some((re) => re.test(key));
}

/**
 * Legacy pre-0.42 state-directory override.
 *
 * agent-browser 0.42 no longer reads `AGENT_BROWSER_STATE_DIR`; use
 * {@link defaultHostEnv} to isolate a host through the supported
 * `AGENT_BROWSER_NAMESPACE` seam instead. Kept for API compatibility.
 */
export function defaultHostStateDir(
  env: NodeJS.ProcessEnv = process.env,
  fallback?: string,
): string | undefined {
  const dshHome = env["DSH_HOME"];
  if (typeof dshHome === "string" && dshHome.length > 0) {
    return path.join(dshHome, "agent-browser");
  }
  return fallback;
}

/**
 * Build the agent-browser isolation env for this host.
 *
 * 0.42 derives state and sockets from `$HOME/.agent-browser`; the supported
 * way to keep one DSH home separate from another (and from other tools) is a
 * stable namespace under `namespaces/<name>`. The name is a short hash so it
 * stays inside the Unix socket path limit.
 *
 * @param env - host environment; `DSH_HOME` selects the namespace.
 * @param fallback - isolation key when `DSH_HOME` is absent.
 * @returns child env overrides, or undefined for the CLI's shared default.
 */
export function defaultHostEnv(
  env: NodeJS.ProcessEnv = process.env,
  fallback?: string,
): Record<string, string> | undefined {
  const dshHome = env["DSH_HOME"];
  const key =
    typeof dshHome === "string" && dshHome.length > 0 ? dshHome : fallback;
  if (key === undefined || key.length === 0) return undefined;
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
  // Unix sockets cap the whole path at ~104 bytes. The default socket dir
  // nests the pnpm/home path and the namespace, so even "default" can overflow
  // in a long DSH_HOME. A short per-host root keeps every session name usable.
  const socketRoot =
    process.platform === "win32"
      ? path.join(os.tmpdir(), `dsh-ab-${digest.slice(0, 8)}`)
      : path.join("/tmp", `dsh-ab-${digest.slice(0, 8)}`);
  return {
    AGENT_BROWSER_NAMESPACE: `dsh-${digest}`,
    AGENT_BROWSER_SOCKET_DIR: socketRoot,
  };
}

/** Build the child env from the host env plus driver-level overrides. */
export function buildChildEnv(hostEnv: NodeJS.ProcessEnv, overrides: EnvOverrides): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (denied(key)) continue;
    out[key] = value;
  }
  if (overrides.idleTimeoutMs !== undefined) {
    out["AGENT_BROWSER_IDLE_TIMEOUT_MS"] = String(Math.max(0, Math.floor(overrides.idleTimeoutMs)));
  }
  if (overrides.allowedDomains && overrides.allowedDomains.length > 0) {
    out["AGENT_BROWSER_ALLOWED_DOMAINS"] = overrides.allowedDomains.join(",");
  } else {
    // Never let an inherited value silently widen a configured containment.
    delete out["AGENT_BROWSER_ALLOWED_DOMAINS"];
  }
  Object.assign(out, overrides.env);
  return out;
}
