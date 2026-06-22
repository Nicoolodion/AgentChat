import { describe, expect, it } from "vitest";

import { applyTodoUpdate, parseTodoItems, renderTodoItems } from "@/lib/agent/orchestrator";

describe("parseTodoItems / renderTodoItems", () => {
  it("parses the canonical checklist produced by todo_create", () => {
    const items = parseTodoItems(["1. [ ] a", "2. [x] b", "3. [X] c"].join("\n"));
    expect(items).toEqual([
      { checked: false, text: "a" },
      { checked: true, text: "b" },
      { checked: true, text: "c" },
    ]);
  });

  it("ignores non-checklist lines and tolerates leading whitespace", () => {
    const items = parseTodoItems("# heading\n  1. [ ] keep me\nnot a todo\n2. [x] done");
    expect(items.map((i) => i.text)).toEqual(["keep me", "done"]);
  });

  it("round-trips through render with renumbering", () => {
    const rendered = renderTodoItems([
      { checked: false, text: "first" },
      { checked: true, text: "second" },
    ]);
    expect(rendered).toBe("1. [ ] first\n2. [x] second");
    expect(parseTodoItems(rendered).map((i) => i.checked)).toEqual([false, true]);
  });
});

describe("applyTodoUpdate", () => {
  const base = [
    { checked: false, text: "a" },
    { checked: false, text: "b" },
    { checked: false, text: "c" },
  ];

  it("marks items done by 1-based index", () => {
    const res = applyTodoUpdate(base, { mark_done: [1, 3] });
    expect(res.items.map((i) => i.checked)).toEqual([true, false, true]);
    expect(res.removed).toBe(0);
    expect(res.added).toBe(0);
    expect(res.ignored).toBe(0);
  });

  it("reopens items with mark_pending", () => {
    const done = base.map(() => ({ checked: true, text: "" }));
    const res = applyTodoUpdate(done, { mark_pending: [1, 3] });
    expect(res.items.map((i) => i.checked)).toEqual([false, true, false]);
  });

  it("appends new items as unchecked", () => {
    const res = applyTodoUpdate(base, { add: ["d", "e"] });
    expect(res.items.map((i) => i.text)).toEqual(["a", "b", "c", "d", "e"]);
    expect(res.items.slice(-2).map((i) => i.checked)).toEqual([false, false]);
    expect(res.added).toBe(2);
  });

  it("removes items using original indices and renumbers the tail", () => {
    const res = applyTodoUpdate(base, { remove: [2] });
    expect(res.items.map((i) => i.text)).toEqual(["a", "c"]);
    expect(res.removed).toBe(1);
    expect(renderTodoItems(res.items)).toBe("1. [ ] a\n2. [ ] c");
  });

  it("applies mark + add + remove together, indices anchored to the pre-call list", () => {
    const res = applyTodoUpdate(base, { mark_done: [1], remove: [2], add: ["d"] });
    expect(res.items).toEqual([
      { checked: true, text: "a" },
      { checked: false, text: "c" },
      { checked: false, text: "d" },
    ]);
    expect(res.removed).toBe(1);
    expect(res.added).toBe(1);
    expect(res.ignored).toBe(0);
  });

  it("counts out-of-range indices as ignored without throwing", () => {
    const res = applyTodoUpdate(base, { mark_done: [9], remove: [42] });
    expect(res.ignored).toBe(2);
    expect(res.items).toEqual(base);
  });

  it("starts from an empty list (todo file missing)", () => {
    const res = applyTodoUpdate([], { add: ["only item"] });
    expect(res.items).toEqual([{ checked: false, text: "only item" }]);
    expect(res.added).toBe(1);
    expect(renderTodoItems(res.items)).toBe("1. [ ] only item");
  });

  it("does not mutate the input array", () => {
    const snapshot = base.map((i) => ({ ...i }));
    applyTodoUpdate(base, { mark_done: [1], remove: [2], add: ["x"] });
    expect(base).toEqual(snapshot);
  });
});
