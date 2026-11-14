import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/errors.ts";

describe("classifyFailure", () => {
  it("classifies the explicit tab_gone code", () => {
    expect(classifyFailure("tab_gone")).toBe("tab_gone");
  });

  it("classifies agent-browser 0.43's closed-tab failure as tab_gone", () => {
    expect(
      classifyFailure("CDP error (Runtime.evaluate): Target closed: CDP session 6F2A1 detached"),
    ).toBe("tab_gone");
  });

  it("classifies agent-browser 0.42's detached-session wording as tab_gone", () => {
    expect(classifyFailure("CDP error (Runtime.evaluate): Session with given id not found.")).toBe(
      "tab_gone",
    );
  });

  it("classifies stale refs and allowlist rejections", () => {
    expect(classifyFailure("Unknown ref: e999")).toBe("ref_not_found");
    expect(classifyFailure("Element not found: @e7")).toBe("ref_not_found");
    expect(classifyFailure("Domain 'example.org' is not in the allowed domains list")).toBe(
      "domain_not_allowed",
    );
  });

  it("returns undefined for unrelated failures", () => {
    expect(classifyFailure("something else broke")).toBeUndefined();
    expect(classifyFailure("Target closed")).toBeUndefined();
  });
});
