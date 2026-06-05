---
name: docx
description: "Create and edit Word documents (.docx) — Template Fill for template-based documents, C# + OpenXML SDK for creation, WIR engine for surgical edits. Use for any .docx task including document creation, editing, comments, revisions, footnotes, TOC, and Markdown-to-Word conversion."
---

# Part 1: Routing

Use `docx_read` (not `file_read` or `ipython`) to read .docx files — it returns structured content with styles, tables, and images.

## Route = What You Have

**1. Template Fill** (`docx_template_fill` tool) — A .docx template/example exists AND you need to create a **new** document following its format.

The user provides a template (e.g. "Musterprotokoll.docx", "report_template.docx") and wants a new document that **follows the template's layout** (cover page, table structures, heading styles) but with **different content**. This is the most common case — use `docx_template_fill` which handles everything in one tool call.

**When to use Template Fill:**
- User says "follow this example/template" and create a new document
- You need to insert images into the document
- The template's cover page / metadata table should be preserved
- More than ~30% of the document content will be replaced

**How it works:** You call `docx_template_fill` with the template path, output path, and an array of sections (each with heading + content + images). The tool preserves the cover page, replaces body content, and inserts images — all in one call.

**2. WIR** (`references/wir-reference.md`) — A .docx exists that needs **surgical edits** preserving its exact structure.

Use WIR ONLY for **small, targeted edits** to an existing document: adding comments, tracked changes, modifying specific paragraphs, filling in a few fields. WIR works in "windows" of paragraphs and requires careful, edit-by-edit operations.

**Do NOT use WIR when:**
- You need to replace most of the document's content (use Template Fill instead)
- You need to insert multiple images (use Template Fill instead)
- The task is "create a new document following this template's format" (use Template Fill)

**3. md2docx** (`references/md2docx-reference.md`) — When you are the Orchestrator (you have `create_subagent` and dispatch `task`) and your sub-agents have returned `.md` files. Convert their output to a formatted Word document using the md2docx pipeline.

If you do NOT have `create_subagent` / `task` tools, you are not an Orchestrator and md2docx does not apply. Do not write markdown yourself and convert with pandoc — the result is mediocre. Use Create (C#) for high-quality output.

**4. Create** (`references/openxml-sdk-reference.md`) — Neither of the above.

No target .docx, no upstream .md. Build the document from scratch using C# + OpenXML SDK via the `docx_build` tool. Do NOT run `./scripts/docx` via `shell`.

---

# Part 2: Decision Flowchart

```
Is there an existing .docx file related to the task?
├── No → Route 4: Create (C# + OpenXML)
└── Yes
    ├── What's the task?
    ├── "Follow this template and create a new document" → Route 1: Template Fill ✓
    ├── "Edit/modify this specific document" with small changes → Route 2: WIR
    ├── "Edit/modify this specific document" with large changes → Route 1: Template Fill ✓
    ├── "Add comments/annotations to this document" → Route 2: WIR
    └── "Convert sub-agent .md output to .docx" → Route 3: md2docx
```

---

# Part 3: Execution

## File Structure

```
docx/
├── SKILL.md                       ← This file (routing + rules)
├── references/
│   ├── openxml-sdk-reference.md   → Creation: patterns, traps, all you need
│   ├── wir-reference.md           → WIR editing interface + patterns
│   ├── md2docx-reference.md       → Citation pipeline → Word conversion
│   ├── chart-reference.md         → Native Word charts (pie, bar, line)
│   ├── omml-reference.md          → OMML math equation patterns
│   └── matplotlib-guide.md        → Charts Word can't do natively
├── scripts/
│   ├── docx                       → Unified entry point (the only script to call)
│   ├── engine/                    → WIR engine (editing core)
│   ├── md2docx/                   → Citation → Word pipeline
│   ├── generate_backgrounds.py    → Style reference: Morandi curves (read for technique, don't call directly)
│   ├── generate_inkwash_backgrounds.py  → Style reference: ink wash
│   ├── generate_swiss_backgrounds.py    → Style reference: Swiss grid
│   ├── generate_geometric_backgrounds.py → Style reference: geometric blocks
│   ├── generate_gradient_backgrounds.py  → Style reference: gradient ribbons
│   └── generate_formal_backgrounds.py    → Style reference: formal double border
└── assets/templates/
    ├── Example.cs                 → English document demo (conditional required)
    └── CJKExample.cs              → Chinese/CJK document demo (conditional required)
```

## Validation

- **Creation**: The `docx_build` tool runs the full pipeline (compile → generate → auto-fix element order → OpenXML validate → business rules)
- **Template Fill**: The `docx_template_fill` tool handles validation internally
- **Editing**: The engine validates internally; after saving, spot-check high-risk areas

## Hard Rules

1. **No manual markdown-to-docx.** Do not write markdown then convert with pandoc. If you are the Orchestrator with upstream .md from sub-agents, use md2docx. Otherwise, always Create (C#) or Template Fill.
2. **Template/example .docx → Template Fill**, not WIR. WIR is for surgical edits only. If the task is "create a new document following this template," always use `docx_template_fill`.
3. Clean up iteration artifacts — no `v1`/`v2`/`final` clutter in the output directory. Deliver clean, clearly named files only.
4. Name output files by topic and match the user's language (e.g., Chinese query → `储能电站分析报告.docx`, English query → `Energy_Storage_Report.docx`). Never `output.docx`.
5. Language consistency — user's conversation language across all elements (body, headings, headers/footers, TOC, chart labels, filenames).
6. Default to the skill's own toolchain; avoid external libraries unless necessary.
7. Use `docx_read` to read .docx files — never use `ipython` or `file_read` for .docx.
8. After choosing a route, read the corresponding reference file **in full** before writing any code. Do not skim or skip sections — traps and required patterns appear throughout.

## Quality Standards

**Low-saturation color palette.** Pick ONE hue direction, build 3 tiers: Primary (headings) / Dark (body text) / Light (captions). Never pure #FF0000/#0000FF. Cover text color must contrast with its background AND be visually distinct from body text (larger size, different weight, generous spacing).

**Cover/backcover backgrounds.** If the document needs a cover, generate a unique background from scratch — read one of the `generate_*.py` scripts to learn the Playwright + SVG technique, then write your own HTML/SVG with original shapes and colors matching the document's palette. Never reuse or directly call existing background scripts. Cover text must feel like a separate visual space from the body, not just a bigger first paragraph.

**Content constraints.** Word count target "X字左右" means ±20% is acceptable.

**Delivery checklist** (verify before delivering):
1. Document opens without errors
2. OpenXML + business rule validation passes
3. Headers, footers, page numbers present and correctly positioned
4. No placeholder text remains (`[Company Name]`, `TODO`, etc.)
5. All images render (build output shows `X images` — if 0, images were not inserted)
6. Cover/backcover text visibly contrasts with background
