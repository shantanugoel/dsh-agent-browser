import { describe, expect, it } from "vitest";
import { redactCookiePayload } from "../src/cookies.ts";

describe("redactCookiePayload", () => {
  it("redacts bare-array payloads", () => {
    const out = redactCookiePayload([{ name: "sid", value: "secret", domain: "x" }]);
    expect(out?.kind).toBe("array");
    const arr = out?.data as Array<{ value: string }>;
    expect(arr[0]!.value).toBe("[redacted]");
  });

  it("redacts the wrapper the real daemon sends", () => {
    const out = redactCookiePayload({ cookies: [{ name: "sid", value: "SECRET" }] });
    expect(out?.kind).toBe("wrapper");
    const wrapped = out?.data as { cookies: Array<{ value: string }> };
    expect(wrapped.cookies[0]!.value).toBe("[redacted]");
    expect(wrapped.cookies[0]!.name).toBe("sid");
  });

  it("leaves non-cookie payloads unrecognized", () => {
    expect(redactCookiePayload({ something: 1 })).toBeUndefined();
    expect(redactCookiePayload("string")).toBeUndefined();
  });
});
