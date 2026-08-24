/**
 * Public types for the dsh-agent-browser web-client subpath
 * (`import("dsh-agent-browser/client")`), consumed by the DSH web shell's
 * module loader. The implementation is the prebundled `client.js`.
 *
 * @module dsh-agent-browser/client
 */

/** Minimal structural typing for the host context slice the panel needs. */
export interface BrowserClientContext {
  slots: {
    /** Register a lazy contribution under a slot key; returns a disposer. */
    inject(key: string, register: () => () => void): () => void;
    /** Contribute a component to an already-injected slot key. */
    register(spec: { name: string; id: string; order?: number }, component: unknown): () => void;
  };
}

/** The live-viewport overlay panel component (React). */
export declare function BrowserPanel(): unknown;

/** Slot keys this module requires the host to provide. */
export const inject: string[];

/** Contribute the panel to the host's `shell.overlay` slot. */
export function apply(ctx: BrowserClientContext): void;
