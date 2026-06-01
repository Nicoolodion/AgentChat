# Chatinterface (NanoGPT + Prisma)

A self-hostable chat interface for NanoGPT-compatible LLM providers, with a
powerful in-browser agent that can create documents, run code, search the web
and reason across multi-step tasks.

## Features

- Username/password accounts (Argon2id) with optional guest/local mode
- Encrypted at rest: chat content, reasoning, tool payloads and titles
- Secure attachment uploads (images, PDF, DOCX/ODT/ODP/PPTX, text files)
- PDF analysis with page-image + text context for multimodal models
- NanoGPT model selection with optional web-search suffix
- Tool-capable agent with a Docker sandbox (Python/Node/.NET, Playwright)
- **Live streaming timeline UI** — see reasoning, tool calls, tool output and
  the final answer in the exact order the agent produced them
- **Page refresh resumes live sessions** — refresh while the agent is running
  and the UI re-attaches to the in-flight execution
- Prisma ORM (SQLite by default, PostgreSQL-ready)
- Production-ready Dockerfile + Compose for Unraid / Linux hosts

## Stack

- Next.js 16 (App Router)
- TypeScript, React 19
- Prisma + SQLite (PostgreSQL-ready)
- NanoGPT OpenAI-compatible API
- Vitest unit tests
- Tailwind CSS v4

## Quick start

```bash
npm install
cp .env.example .env
# Edit .env and set NANOGPT_API_KEY and the two encryption keys
npm run prisma:generate
npm run prisma:push
npm run dev
```

Open <http://localhost:3000>.

### Generate strong keys

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Production deploy (Docker)

The repository ships with a multi-stage `Dockerfile` and `docker-compose.yml`.

```bash
cp .env.example .env
# Edit .env (set real keys + DATABASE_URL to a path under /app/data)
docker compose up -d --build
```

The app listens on `127.0.0.1:3000` by default — point your reverse proxy at it.
All state (DB, encrypted user uploads, agent workspaces) is persisted in the
host-mounted `./data` directory.

To also run the agent sandbox on the same host:

```bash
docker compose --profile full up -d
```

### Standalone agent sandbox

The agent runs inside a separate, capability-dropped Docker container. Build and
start it with the bundled compose file:

```bash
docker compose -f docker-sandbox/docker-compose.agent.yml up -d
```

The Next.js backend talks to it over HTTP at `AGENT_SANDBOX_URL`.

## Auth and security

- Passwords are hashed with Argon2id; never stored in plain text.
- Chat content, reasoning, tool payloads and titles are encrypted at rest
  (AES-256-GCM) using a per-user key derived from the password.
- Uploaded attachments are encrypted at rest per user; auto-expire after 30 days.
- Session cookies are HttpOnly + SameSite=lax + Secure (in production).
- Registration can be toggled via `REGISTRATION_ENABLED`.
- Rate limiting on auth endpoints (per-IP).

## Architecture

```
src/
  app/
    api/                  # Next.js Route Handlers (REST + SSE)
      agent/sessions/[sessionId]/stream   # ← live re-attach after refresh
      chats/[…]/messages                  # ← chat completion SSE
      auth/                              # login / register / logout / me
      uploads/                           # encrypted file uploads
    chat/page.tsx         # Main chat surface
  components/
    chat/
      MessageTimeline.tsx # ordered timeline UI (left rail + dot per step)
      useChatStream.ts    # shared SSE consumer for both send + restore
    agent/                # Agent sidebar (terminal, files, artifacts)
  lib/
    agent/                # Orchestrator, sandbox client, workspace helpers
    chat-store.ts         # DB layer (encrypted columns)
    crypto.ts             # AES-256-GCM helpers
    auth.ts               # Session / user key handling
    nanogpt.ts            # OpenAI client + streaming
```

### Live timeline

Assistant messages are rendered as an ordered **timeline** with a left rail
that connects every step the agent emitted:

1. **Reasoning** (collapsed by default — click to expand)
2. **Tool call** with argument preview and live status
3. **Tool output** streamed under the call
4. **Final text** with markdown rendering
…

Steps are NOT grouped by kind — they appear in the exact order the agent
produced them.

### Refresh-safe sessions

When you load a chat that has an agent session still in `thinking` or
`executing` state, the client opens an SSE connection to
`/api/agent/sessions/:id/stream`. The server replays all persisted tool
calls as `replay_tool_start` / `replay_tool_output` / `replay_tool_done`
events, then polls the database for new tool calls and forwards status changes
until the session finishes. The UI never "loses" the timeline — it just keeps
filling in.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run dev server |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | ESLint |
| `npm run test` | Vitest |
| `npm run prisma:generate` | Generate Prisma client |
| `npm run prisma:push` | Sync schema to DB |
| `npm run prisma:studio` | Open Prisma Studio |

## PostgreSQL switch

1. Update Prisma datasource `provider` in `prisma/schema.prisma` to `postgresql`.
2. Set `DATABASE_URL` to your PostgreSQL connection string.
3. `npx prisma migrate dev --name switch-to-postgres`.

## Tests

`npm run test` runs unit tests for:
- Crypto helpers
- Password hashing/verification
- Web-search model suffix behavior
