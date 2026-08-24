/** @module dsh-agent-browser-core */
export * from "./types.ts";
export * from "./errors.ts";
export { resolveAgentBrowserBinary, type ResolvedBinary } from "./binary.ts";
export { buildChildEnv, type EnvOverrides } from "./env.ts";
export {
  AgentBrowserClient,
  type AgentBrowserClientConfig,
  type CallOptions,
  type CallResult,
} from "./client.ts";
export {
  probe,
  ensureHealthy,
  stopSession,
  stopAllSessions,
  listSessions,
  type DaemonHealth,
} from "./daemon.ts";
export {
  BrowserSession,
  stepToArgv,
  type ActAction,
  type FoundNode,
  type OpenOptions,
  type SnapshotOptions,
  type ScreenshotResult,
  type TargetRef,
} from "./session.ts";
export {
  SessionRegistry,
  type RegistryEvent,
  type SessionEntry,
} from "./registry.ts";
export {
  SessionStream,
  resolveStreamPort,
  type StreamEvents,
  type StreamFrame,
  type StreamOptions,
} from "./stream.ts";