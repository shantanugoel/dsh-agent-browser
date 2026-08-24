/**
 * Cookie redaction policy. The daemon has been observed returning BOTH bare
 * arrays and `{ cookies: [...] }` wrappers depending on version — redact
 * every known cookie field wherever it appears. Unknown shapes pass through
 * untouched (the caller logs them), but arrays of cookie-like objects are
 * always covered.
 *
 * @module dsh-agent-browser/cookies
 */

/** Fields on a cookie that carry secret material. */
const SECRET_FIELDS = ["value"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Redact one list of cookie objects. */
function redactList(list: unknown[]): unknown[] {
  return list.map((cookie) => {
    if (!isRecord(cookie)) return cookie;
    const out: Record<string, unknown> = { ...cookie };
    for (const field of SECRET_FIELDS) {
      if (field in out) out[field] = "[redacted]";
    }
    return out;
  });
}

export interface ArrayPayload {
  kind: "array";
  data: unknown[];
}
export interface WrapperPayload {
  kind: "wrapper";
  data: Record<string, unknown>;
}

export function redactCookiePayload(
  payload: unknown,
): ArrayPayload | WrapperPayload | undefined {
  if (Array.isArray(payload)) {
    return { kind: `array`, data: redactList(payload) };
  }
  if (isRecord(payload) && Array.isArray(payload[`cookies`])) {
    return {
      kind: `wrapper`,
      data: { ...payload, cookies: redactList(payload[`cookies`]) },
    };
  }
  return undefined;
}