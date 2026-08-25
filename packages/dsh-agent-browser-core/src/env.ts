/**
 * Child-process environment assembly. Daemons inherit a scrubbed copy of the
 * host environment: harness-specific variables never cross the boundary, and
 * obvious credential-shaped names are dropped. Computed agent-browser
 * overrides (idle timeout, allowlist) are appended last so they win.
 *
 * @module dsh-agent-browser-core/env
 */

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
 * Isolate this host's daemons from other agent-browser users on the machine.
 * When `DSH_HOME` is set (a DSH process), state lives under `$DSH_HOME/agent-browser`
 * instead of `~/.agent-browser`. Returns undefined to keep the CLI default.
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
