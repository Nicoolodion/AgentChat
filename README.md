# Chatinterface (NanoGPT + Prisma)

A modern, secure chat interface for LLMs with:

- Username/password accounts
- Registration protection and feature toggles
- Encrypted chat/message storage per user
- Secure attachment uploads (images, PDF, DOCX/ODP/ODT/PPTX, text-like files)
- PDF analysis with page-image + text context for multimodal models
- NanoGPT model selection + optional web search suffix
- Tool-capable agent loop
- Prisma ORM with SQLite now and PostgreSQL-ready migration path

## Stack

- Next.js 16 (App Router)
- TypeScript
- Prisma + SQLite (`prisma/schema.prisma`)
- NanoGPT OpenAI-compatible API (`https://nano-gpt.com/api`)
- Vitest unit tests

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
```

Then set at least:

- `NANOGPT_API_KEY`
- `APP_ENCRYPTION_KEY` (32-byte base64 key)
- `SESSION_ENCRYPTION_KEY` (32-byte base64 key)

3. Generate Prisma client and create the SQLite DB:

```bash
npm run prisma:generate
npm run prisma:push
```

4. Start dev server:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Auth and Security

- Passwords are hashed with Argon2id (`@node-rs/argon2`), never stored in plain text.
- Chat content, reasoning, tool payloads, and chat titles are encrypted at rest (AES-256-GCM).
- Uploaded attachments are encrypted at rest per user in `DATA_DIR/<userId>` and auto-expire after 30 days.
- Session cookies are HttpOnly + SameSite and map to server-side session records.
- Registration and auth can be toggled via env:
	- `AUTH_REQUIRED=true|false`
	- `REGISTRATION_ENABLED=true|false`

## NanoGPT Integration

- Model list is fetched from `GET /v1/models?detailed=true` via `NANOGPT_BASE_URL`.
- Selected model can be augmented with `:online` when web search is toggled.
- Tool-capable responses are supported via OpenAI-style `tools` and tool-call loop.

## Scripts

- `npm run dev` - run dev server
- `npm run build` - production build
- `npm run lint` - lint project
- `npm run test` - run unit tests
- `npm run prisma:generate` - generate Prisma client
- `npm run prisma:push` - sync schema to DB
- `npm run prisma:studio` - launch Prisma Studio

## Future PostgreSQL Switch

When you are ready to move from SQLite to PostgreSQL:

1. Update Prisma datasource `provider` in `prisma/schema.prisma` from `sqlite` to `postgresql`.
2. Set `DATABASE_URL` to your PostgreSQL connection string.
3. Run:

```bash
npm run prisma:generate
npx prisma migrate dev --name switch-to-postgres
```

## Tests

Included unit tests cover:

- Crypto helpers
- Password hashing/verification helpers
- Web-search model suffix behavior
