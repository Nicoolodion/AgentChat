import { describe, expect, it } from "vitest";

import { applyWebSearchSuffix } from "@/lib/nanogpt";

describe("applyWebSearchSuffix", () => {
  it("adds online suffix when enabled", () => {
    expect(applyWebSearchSuffix("gpt-4o-mini", true)).toBe("gpt-4o-mini:online");
  });

  it("removes online suffix when disabled", () => {
    expect(applyWebSearchSuffix("gpt-4o-mini:online", false)).toBe("gpt-4o-mini");
  });

  it("keeps non-search suffixes", () => {
    expect(applyWebSearchSuffix("gpt-4o-mini:memory-30", true)).toBe("gpt-4o-mini:online:memory-30");
  });
});
