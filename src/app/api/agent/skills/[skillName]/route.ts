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
