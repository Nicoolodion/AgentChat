import { NextResponse } from "next/server";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { resolveAuthContext } from "@/lib/auth";
import type { SkillDetail } from "@/lib/agent/types";

const SKILLS_DIR = path.resolve(process.cwd(), "skills");

/**
 * GET /api/agent/skills/:skillName
 * Get full documentation for a skill.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ skillName: string }> }
) {
  try {
    const auth = await resolveAuthContext(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { skillName } = await context.params;
    const skillDir = path.join(SKILLS_DIR, skillName);

    let skillMd = "";
    const references: SkillDetail["references"] = [];

    try {
      skillMd = await readFile(path.join(skillDir, "SKILL.md"), "utf-8");
    } catch {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    }

    try {
      const refsDir = path.join(skillDir, "references");
      const entries = await readdir(refsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          references.push({
            name: entry.name,
            path: `references/${entry.name}`,
          });
        }
      }
    } catch {
      // No references directory
    }

    // Some skills (e.g. pptx) organize their docs under format/ and guideline/
    // instead of references/. Surface those recursively so the detail endpoint
    // gives a complete picture of the skill's reference tree.
    for (const sub of ["format", "guideline"]) {
      try {
        const subDir = path.join(skillDir, sub);
        const stack: Array<{ dir: string; rel: string }> = [{ dir: subDir, rel: sub }];
        while (stack.length > 0) {
          const { dir, rel } = stack.pop()!;
          let entries: import("node:fs").Dirent[];
          try {
            entries = await readdir(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const entry of entries) {
            const childRel = `${rel}/${entry.name}`;
            if (entry.isDirectory()) {
              stack.push({ dir: path.join(dir, entry.name), rel: childRel });
            } else if (entry.isFile() && entry.name.endsWith(".md")) {
              references.push({ name: childRel, path: childRel });
            }
          }
        }
      } catch {
        // optional directory
      }
    }

    const skill: SkillDetail = {
      name: skillName,
      SKILL_md: skillMd,
      references,
    };

    return NextResponse.json({ skill });
  } catch (error) {
    console.error("[Agent Skill Detail GET Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
