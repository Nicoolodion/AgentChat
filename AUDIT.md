# Chatinterface — Full Code Audit (2026-07-09)

> Comprehensive audit of the `chatinterface-app/` codebase.
> Findings are de-duplicated and prioritized: **Security**, **Robustness
> / data integrity**, **Config & deploy**, **UX / known issues**, **Code quality**.
> Each item lists severity, `file:line` refs, the problem, and a suggested fix.
> Status markers: ❌ not fixed · ✅ fixed · ⏳ partial.

---

## C. CONFIG & DEPLOY

### C15. ❌ `tsconfig.json` lacks stricter flags — LOW
`tsconfig.json:7` enables `strict` but not `noUncheckedIndexedAccess` /
`noImplicitOverride`.

**Fix:** add `noUncheckedIndexedAccess:true`, `exactOptionalPropertyTypes:true`
and fix fallout.

---

## D. UX / KNOWN ISSUES

### D11. ⏳ Attachment PDF preview cross-browser (FINDINGS3.md UX1) — LOW
Still uses `<iframe>`; Safari/Firefox inline PDF rendering needs `react-pdf`
or canvas.

### D12. ❌ Inconsistent response shapes across endpoints — LOW
Success shapes vary (`{ ok:true }`, `{ ok:true, chat }`, `{ chat }`,
`{ sessions }`, `{ session, toolCalls, artifacts }`, `{ stopped:true }`,
`{ success:true }`, `{ ok:false, message }`). Error shapes vary (`{ error }`,
`{ error, detail }`, raw `Response("text…")`). E.g. `stop/route.ts:51` returns
`{ stopped:true }` while `sessions/[id]/route.ts:108` returns `{ success:true }`
for the same conceptual delete.

**Fix:** standardize on `{ ok:true, data }` / `{ error:{ message, code? } }`.

### D17. ❌ Multi-model support within a single agent session (FINDINGS3.md A1) — LOW
Deferred; would require architectural changes.

### D18. ❌ Agent streaming of intermediate Python output (FINDINGS3.md A5) — LOW
Deferred; would need WebSocket / chunked HTTP in the sandbox server.

### D19. ❌ Code execution caching (FINDINGS3.md A4) — LOW
Deferred; would need sandbox-side bytecode caching.

---

## Verification commands

```bash
npx tsc --noEmit            # TypeScript typecheck
npx eslint                  # lint
npx vitest run              # unit tests
python -m py_compile docker-sandbox/app/lib/sandbox_server.py   # Python byte compile
```
