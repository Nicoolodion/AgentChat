export type ParsedArgs =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

export function parseToolArgs(raw: string): ParsedArgs {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  let parsed = tryParse(raw);
  if (parsed === null) {
    parsed = tryParse(raw.replace(/,\s*([}\]])/g, "$1"));
  }
  if (parsed === null) {
    const objStart = raw.indexOf("{");
    const objEnd = raw.lastIndexOf("}");
    if (objStart !== -1 && objEnd > objStart) {
      parsed = tryParse(raw.slice(objStart, objEnd + 1));
    }
  }
  if (parsed === null) {
    return { ok: false, error: "Failed to parse tool-call arguments as JSON." };
  }
  return { ok: true, args: parsed };
}

export function safeParseArgs(raw: string): Record<string, unknown> {
  const result = parseToolArgs(raw);
  return result.ok ? result.args : {};
}
