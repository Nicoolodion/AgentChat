import { describe, expect, it } from "vitest";

import { safeParseArgs } from "@/lib/agent/parse-args";

describe("safeParseArgs", () => {
  it("parses valid json", () => {
    expect(safeParseArgs('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });
  it("recovers from trailing commas", () => {
    expect(safeParseArgs('{"a":1,}')).toEqual({ a: 1 });
    expect(safeParseArgs("[1,2,]")).toEqual([1, 2]);
  });
  it("extracts the first balanced object from noisy surrounding text", () => {
    expect(safeParseArgs('prefix {"a":2} suffix')).toEqual({ a: 2 });
  });
  it("returns empty object when nothing parses", () => {
    expect(safeParseArgs("totally not json")).toEqual({});
  });
});
