import { NextResponse } from "next/server";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { resolveAuthContext } from "@/lib/auth";
import { sandboxHealthCheck } from "@/lib/agent/sandbox";
import type { SkillInfo } from "@/lib/agent/types";

const SKILLS_DIR = path.resolve(process.cwd(), "skills");

/**
 * GET /api/agent/skills
 * List available skills with metadata parsed from SKILL.md frontmatter.
 */
export async function GET(request: Request) {
  try {
    const auth = await resolveAuthContext(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const skills: SkillInfo[] = [];

    try {
      const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
      const skillDirs = entries.filter((e) => e.isDirectory());

      for (const dir of skillDirs) {
        const skillMdPath = path.join(SKILLS_DIR, dir.name, "SKILL.md");
        let description = "";
        let routes: SkillInfo["routes"] = [];
        let dependencies: SkillInfo["dependencies"] = [];

        try {
          const md = await readFile(skillMdPath, "utf-8");
          const parsed = parseSkillMd(md);
          description = parsed.description;
          routes = parsed.routes;
          dependencies = parsed.dependencies;
        } catch {
          description = `Skill: ${dir.name}`;
        }

        skills.push({
          name: dir.name,
          description,
          routes,
          dependencies,
        });
      }
    } catch {
      // Skills directory may not exist yet
    }

    return NextResponse.json({ skills });
  } catch (error) {
    console.error("[Agent Skills GET Error]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

function parseSkillMd(md: string): {
  description: string;
  routes: SkillInfo["routes"];
  dependencies: SkillInfo["dependencies"];
} {
  let description = "";
  const routes: SkillInfo["routes"] = [];
  const dependencies: SkillInfo["dependencies"] = [];

  // Simple YAML frontmatter parser
  const frontmatterMatch = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (frontmatterMatch) {
    const fm = frontmatterMatch[1];
    const descMatch = fm.match(/description:\s*"([^"]*)"/);
    if (descMatch) description = descMatch[1];

    // Parse routes
    const routesMatch = fm.match(/routes:\s*\n([\s\S]*?)(?=\n\w|\n---|$)/);
    if (routesMatch) {
      const routeLines = routesMatch[1].split("\n");
      let currentRoute: { name?: string; condition?: string } = {};
      for (const line of routeLines) {
        const nameMatch = line.match(/^\s*-\s*name:\s*(.+)/);
        const condMatch = line.match(/^\s*condition:\s*(.+)/);
        const refMatch = line.match(/^\s*reference:\s*(.+)/);
        if (nameMatch) {
          if (currentRoute.name) {
            routes.push({
              name: currentRoute.name,
              condition: currentRoute.condition ?? "",
            });
          }
          currentRoute = { name: nameMatch[1].trim() };
        }
        if (condMatch) currentRoute.condition = condMatch[1].trim();
        if (refMatch) {
          // End of route block
        }
      }
      if (currentRoute.name) {
        routes.push({ name: currentRoute.name, condition: currentRoute.condition ?? "" });
      }
    }

    // Parse dependencies
    const depsMatch = fm.match(/dependencies:\s*\n([\s\S]*?)(?=\n\w|\n---|$)/);
    if (depsMatch) {
      const depLines = depsMatch[1].split("\n");
      let currentDep: { name?: string; check?: string } = {};
      for (const line of depLines) {
        const nameMatch = line.match(/^\s*-\s*name:\s*(.+)/);
        const checkMatch = line.match(/^\s*check:\s*(.+)/);
        if (nameMatch) {
          if (currentDep.name) {
            dependencies.push({
              name: currentDep.name,
              status: "unknown",
              version: undefined,
            });
          }
          currentDep = { name: nameMatch[1].trim() };
        }
        if (checkMatch) currentDep.check = checkMatch[1].trim();
      }
      if (currentDep.name) {
        dependencies.push({ name: currentDep.name, status: "unknown" });
      }
    }
  }

  return { description, routes, dependencies };
}
