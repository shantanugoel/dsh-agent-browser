/**
 * Session registry with activity events. Hosts (the DSH bundle, the pi
 * adapter) derive one registry per process; subagents use named sessions and
 * the default session stays keyed by the owning conversation.
 *
 * @module dsh-agent-browser-core/registry
 */

import { AgentBrowserClient, type AgentBrowserClientConfig } from "./client.ts";
import { BrowserSession } from "./session.ts";

/** Metadata tracked for every registered session. */
export interface SessionEntry {
  name?: string;
  session: BrowserSession;
  createdAt: number;
  lastUsedAt: number;
  /** Free-form label for cards/panels ("subagent:researcher"). */
  label?: string;
}

export type RegistryEvent =
  | { type: "created"; name?: string }
  | { type: "used"; name?: string }
  | { type: "closed"; name?: string };

/**
 * Tracks live {@link BrowserSession} handles and emits coarse lifecycle
 * events the activity feed mirrors into presentation cards. Not a daemon
 * source of truth: agent-browser's own `session list` is; this is the
 * host-side view of sessions WE created.
 */
export class SessionRegistry {
  private entries = new Map<string, SessionEntry>();
  private listeners = new Set<(event: RegistryEvent) => void>();
  private reapTimer: ReturnType<typeof setInterval> | null = null;

  /** The shared CLI client behind all sessions of this registry. */
  readonly client: AgentBrowserClient;

  /**
   * @param clientConfig driver configuration for every session.
   * @param options host lifecycle knobs. When `idleTimeoutMs` exceeds zero a
   * low-frequency reaper closes tracked sessions untouched longer than that
   * (the daemon has its own idle exit; this reaps OUR handles and frees the
   * browser promptly).
   */
  constructor(
    clientConfig: AgentBrowserClientConfig = {},
    options: { idleTimeoutMs?: number; reapIntervalMs?: number } = {},
  ) {
    this.client = new AgentBrowserClient(clientConfig);
    const idleTimeoutMs = Math.max(0, Math.round(options.idleTimeoutMs ?? 0));
    if (idleTimeoutMs > 0) {
      const intervalMs = Math.max(1_000, options.reapIntervalMs ?? Math.min(idleTimeoutMs / 2, 30_000));
      this.reapTimer = setInterval(() => void this.reapIdle(idleTimeoutMs), intervalMs);
      // Never hold a host process open just for the reaper.
      this.reapTimer.unref?.();
    }
  }

  /** Close every entry idle beyond `idleTimeoutMs`; errors drop the handle. */
  private async reapIdle(idleTimeoutMs: number): Promise<void> {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsedAt <= idleTimeoutMs) continue;
      const name = entry.name;
      try {
        await this.closeSession(name);
      } catch {
        this.forget(name);
        void key;
      }
    }
  }

  /**
   * Grant extra allowed domains at runtime (host approval flows). Delegates
   * to the client so the next daemon spawn sees the merged allowlist.
   */
  grantDomains(domains: readonly string[]): void {
    this.client.grantAllowedDomains(domains);
  }

  /** Current effective allowlist. */
  get allowedDomains(): readonly string[] {
    return this.client.allowedDomains;
  }

  /** Stop the reaper timer (hosts call this during teardown). */
  dispose(): void {
    if (this.reapTimer !== null) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
  }

  on(listener: (event: RegistryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: RegistryEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* listener errors never break the registry */
      }
    }
  }

  private keyOf(name?: string): string {
    return name ?? "__default__";
  }

  /** True when this registry already tracks `name` (does not create or touch). */
  has(name?: string): boolean {
    return this.entries.has(this.keyOf(name));
  }

  /** Existing handle, or undefined — never creates a session or boots a daemon. */
  peek(name?: string): BrowserSession | undefined {
    return this.entries.get(this.keyOf(name))?.session;
  }

  /** Get-or-create the session handle for one name. */
  session(name?: string, opts: { label?: string } = {}): BrowserSession {
    const key = this.keyOf(name);
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      this.emit({ type: "used", name });
      return existing.session;
    }
    const session = new BrowserSession(this.client, name);
    this.entries.set(key, {
      name,
      session,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      ...(opts.label ? { label: opts.label } : {}),
    });
    this.emit({ type: "created", name });
    return session;
  }

  /** All registered entries, oldest first. */
  list(): SessionEntry[] {
    return [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Drop a handle from the registry WITHOUT closing the browser. */
  forget(name?: string): void {
    this.entries.delete(this.keyOf(name));
    this.emit({ type: "closed", name });
  }

  /** Close a session's browser and drop its handle. */
  async closeSession(name?: string): Promise<void> {
    const entry = this.entries.get(this.keyOf(name));
    try {
      await entry?.session.close();
    } finally {
      this.entries.delete(this.keyOf(name));
      this.emit({ type: "closed", name });
    }
  }

  /**
   * Close every session THIS registry created. Does not run `close --all`
   * (that would kill daemons owned by other hosts sharing a state dir).
   */
  async closeAll(): Promise<void> {
    const names = this.list().map((entry) => entry.name);
    for (const name of names) {
      try {
        await this.closeSession(name);
      } catch {
        this.forget(name);
      }
    }
  }
}