export function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    try {
      const fixed = raw.replace(/,\s*([}\]])/g, "$1");
      return JSON.parse(fixed) as Record<string, unknown>;
    } catch {
      const objStart = raw.indexOf("{");
      const objEnd = raw.lastIndexOf("}");
      if (objStart !== -1 && objEnd > objStart) {
        try {
          return JSON.parse(raw.slice(objStart, objEnd + 1)) as Record<string, unknown>;
        } catch {
          /* give up */
        }
      }
      return {};
    }
  }
}
