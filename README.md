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

The repo ships with a multi-stage `Dockerfile` (app), a `docker-sandbox/Dockerfile`
(sandbox), a `deploy/Dockerfile` (deploy webhook receiver), and
`docker-compose.yml`. **Images are built by GitHub Actions and published to GHCR**
— the host only pulls prebuilt images, so updates are fast and put no build load
on Unraid. Deploys are triggered over HTTPS via the webhook receiver (no inbound
SSH to your server).

### One-time setup on Unraid

1. Clone the repo and create the env file (the `.env` is gitignored and never
   touched by deploys, so your secrets survive updates):

   ```bash
   git clone https://github.com/Nicoolodion/AgentChat.git /mnt/user/appdata/AgentChat
   cd /mnt/user/appdata/AgentChat
   cp .env.example .env
   # Edit .env: set NANOGPT_API_KEY + the two encryption keys + DATABASE_URL,
   #   plus HOST_DEPLOY_PATH (the absolute path above) and WEBHOOK_SECRET.
   ```

2. Start the stack (app + sandbox + deploy-webhook):

   ```bash
   docker compose --profile full up -d
   ```

   > If the repo is **public**, GHCR packages are public too and the host can
   > `docker pull` them with no login. If private, run
   > `docker login ghcr.io -u Nicoolodion` once with a PAT that has
   > `read:packages`.

3. Expose the deploy webhook through your reverse proxy. Add a new proxy host
   (e.g. `deploy.nicoolodion.com`) forwarding to `127.0.0.1:9000` with HTTPS
   (Let's Encrypt). The app itself is served by pointing a proxy host at
   `127.0.0.1:3000`.

Point your chat reverse proxy at `127.0.0.1:3000`. All state (DB, encrypted
uploads, agent workspaces) persists in the host-mounted `./data` directory.

### Updating

- **Automatic (recommended):** pushing to `master` (or the Actions "Run workflow"
  button) triggers `.github/workflows/build-and-deploy.yml`, which builds & pushes
  all three images to GHCR, then POSTs to `deploy.nicoolodion.com/deploy`. The
  `deploy-webhook` container validates the secret, runs `deploy/deploy.sh`
  (`git reset --hard origin/master` → `compose pull app agent-sandbox` →
  recreate), and returns the log to the workflow. Nothing to do by hand.
- **Manual:** on the host,

  ```bash
  docker compose --profile full pull
  docker compose --profile full up -d --remove-orphans
  ```

Note: the webhook updates **app + sandbox only** — never itself (it would kill
its own HTTP response mid-deploy). The webhook image rarely changes; when it
does, pull + recreate it by hand:

```bash
docker compose --profile full pull deploy-webhook
docker compose --profile full up -d --no-deps --force-recreate deploy-webhook
```

### Required GitHub secrets (for automatic deploy)

In **Settings → Secrets and variables → Actions**, add:

| Secret | Example | Purpose |
| --- | --- | --- |
| `WEBHOOK_URL` | `https://deploy.nicoolodion.com/deploy` | HTTPS endpoint of the webhook receiver |
| `WEBHOOK_SECRET` | *(random)* | Shared secret; must match `WEBHOOK_SECRET` in `.env` on Unraid |

Generate the secret locally with `openssl rand -hex 32` and put the same value
in both the GitHub secret and Unraid's `.env`.


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
