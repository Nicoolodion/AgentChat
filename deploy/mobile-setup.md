# Mobile Task Launcher — Setup & Update Guide

This update adds: start a Task from your phone (or the new `/m` web page),
the agent runs it headless, you get the result **by email + a push
notification**, and you can **reply to that email to continue** the
conversation. Native Android app + APK releases via GitHub Actions.

It's fully self-hosted. No Google/Firebase. Push is via **ntfy** (UnifiedPush).

---

## 0. What changed (at a glance)

| Area | What's new |
|----|----|
| Database | 4 new tables: `UserEmail`, `UserMobileToken`, `MobileTask`, `UserProfile`. A migration is included. |
| New compose service | `ntfy` (self-hosted push server, profile `full`). |
| New env vars | `MAIL_*` (SMTP out), `MAIL_INBOX_*` (IMAP in), `NTFY_*` (push), `PUBLIC_BASE_URL`. All **optional** — missing any degrades gracefully. |
| New routes | `/m` (mobile web), `/api/mobile/*`, `/api/tasks`, `/api/locale`, `/api/email/*`. |
| Agent tool | `send_email` + `skills/email/SKILL.md` ("schick es mir per Email" works). |
| Android app | `android-app/` — signed APK built on `mobile-v*` tags. |

---

## 1. On your workstation — commit & push (your normal flow)

```sh
cd chatinterface-app
git add -A
git commit -m "feat: mobile task launcher + email-reply + ntfy push + android app"
git push origin master
```

Pushing to `master` triggers `build-and-deploy.yml` which builds + pushes the
**app + sandbox + webhook** images and POSTs to your deploy webhook. Your
Unraid auto-updates the app + sandbox containers as usual.

> The new `ntfy` container is **NOT** built by CI (it uses the upstream
> image). You create it once on the host (Step 3). The `android-release.yml`
> workflow runs separately on `mobile-v*` tags (Step 6).

---

## 2. Edit `.env` on Unraid (once, before deploying)

SSH into your Unraid, edit
`/mnt/user/appdata/AgentChat/.env` (your `HOST_DEPLOY_PATH`):

```dotenv
# Public base URL of your app (used to build verification + artifact links)
PUBLIC_BASE_URL=https://chat.nicoolodion.com

# ── Outbound mail (SMTP) — REQUIRED if you want email results ──
MAIL_FROM=agent@nicoolodion.com
MAIL_SMTP_HOST=smtp.your-provider.com
MAIL_SMTP_PORT=587
MAIL_SMTP_SECURE=false
MAIL_SMTP_USER=agent@nicoolodion.com
MAIL_SMTP_PASS=<your-smtp-password>

# ── Inbound mail (IMAP poller) — REQUIRED for email-reply continuation ──
# Disable with MAIL_INBOUND_ENABLED=false to skip the poller entirely.
MAIL_INBOUND_ENABLED=true
MAIL_INBOX_HOST=imap.your-provider.com
MAIL_INBOX_PORT=993
MAIL_INBOX_USER=agent@nicoolodion.com
MAIL_INBOX_PASS=<your-imap-password>
MAIL_INBOX_POLL_SECONDS=30

# ── Push (self-hosted ntfy / UnifiedPush) ──
NTFY_BASE_URL=https://ntfy.nicoolodion.com
NTFY_DEFAULT_AUTH=          # set AFTER Step 5 (one-time, see below)
```

> **Mailbox**: you need an email account for `agent@nicoolodion.com` that can
> both **send (SMTP)** and **receive (IMAP)**. Any standard mailbox provider
> works (your domain host, Migadu, Posteo, etc.). The agent mailbox must be a
> real inbox the IMAP poller can read; replies land there.

> **Leave `NTFY_DEFAULT_AUTH` blank for now** — you'll fill it after creating
> the publish token in Step 5. Leaving mail/ntfy vars unset means the app
> simply skips that leg (push-only, email-only, or neither).

After editing `.env`, on the host:

```sh
cd /mnt/user/appdata/AgentChat
```

---

## 3. Create the ntfy container (one-time)

The compose file now declares an `ntfy` service under the `full` profile. On
the host:

```sh
cd /mnt/user/appdata/AgentChat
git pull   # gets the new docker-compose.yml + deploy/ntfy.yml

# Create the ntfy data dir + config (commited already, but ensure it exists)
mkdir -p data/ntfy

# Start everything including ntfy (this also recreates the updated app image)
docker compose --profile full pull
docker compose --profile full up -d
```

Verify:

```sh
docker compose --profile full ps   # chatinterface-ntfy should be Up
docker logs chatinterface-ntfy --tail 20
```

The IMAP poller + notify dispatcher start automatically from
`instrumentation.ts` on app boot.

---

## 4. Cloudflare / DNS

You already have `chat.nicoolodion.com` → your app. Add **one new DNS record**
for the push server:

| Type | Name | Target | Proxy |
|----|----|----|----|
| A/AAAA | `ntfy` | your Unraid IP (or your existing tunnel/CNAME) | Proxied ✅ |

Then point it at the ntfy container's port (`8090` on the host). The exact
reverse-proxy block depends on your setup (see Step 5).

> If you use Cloudflare Tunnel (cloudflared) instead of opening ports, add an
> ingress rule for `ntfy.nicoolodion.com` → `http://chatinterface-ntfy:80`
> (the container name on the `app-net` network), or
> `http://<unraid-ip>:8090`.

**Cloudflare settings for ntfy (important):**
- The ntfy WebSocket/long-poll needs unlimited timeouts. Under
  **Network → WebSockets** keep enabled.
- For the `ntfy` DNS record, consider lowering **Edge TTL / Cache** to 0 or
  bypass caching for that hostname (ntfy is streaming, not cacheable). Easiest:
  a Cloudflare **Configuration Rule** that disables caching + sets
  "Origin Cache Control" for `ntfy.nicoolodion.com`.
- Cloudflare free-tier caps at 100s for idle requests. ntfy uses long-held
  connections; if pushes get cut off, either enable Cloudflare's
  "WebSocket" transport (ntfy falls back to it) or run `ntfy` on the
  Cloudflare Tunnel with the grpc/websocket passthrough.

**No new records for email** — `agent@nicoolodion.com` MX handling stays with
your mail provider; only the app needs SMTP/IMAP creds (Step 2).

---

## 5. Unraid / Nginx reverse proxy

You need a reverse-proxy entry so `ntfy.nicoolodion.com` reaches the container.

### If you run Nginx Proxy Manager (NPM) on Unraid
1. **Hosts → Proxy Hosts → Add Proxy Host**
   - Domain Names: `ntfy.nicoolodion.com`
   - Scheme: `http`, Forward Hostname: `<unraid-ip>` (or `chatinterface-ntfy` if NPM runs in the same docker network), Forward Port: `8090`
   - SSL: Cloudflare full certificate (or request a Let's Encrypt cert)
2. **Custom Nginx config** (to allow long-lived streaming):
   ```nginx
   proxy_http_version 1.1;
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   proxy_set_header Host $host;
   proxy_read_timeout 86400s;
   proxy_send_timeout 86400s;
   proxy_buffering off;
   ```

### If you run raw nginx
Add a server block:
```nginx
server {
  listen 443 ssl http2;
  server_name ntfy.nicoolodion.com;

  location / {
    proxy_pass http://127.0.0.1:8090;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 86400s;
    proxy_send_timeout 86400s;
    proxy_buffering off;
  }
}
```
Reload nginx.

### Create the ntfy publish token (one-time)
After the container is running:
```sh
docker exec -it chatinterface-ntfy ntfy user add \
  --role admin admin
# remember the password

docker exec -it chatinterface-ntfy ntfy token create publisher
# prints a token like tk_xxxxxxxx...
```
Put that token's value in `/mnt/user/appdata/AgentChat/.env`:
```dotenv
NTFY_DEFAULT_AUTH=tk_xxxxxxxx...
```
Restart the app so it picks it up:
```sh
cd /mnt/user/appdata/AgentChat
docker compose --profile full up -d app
```

---

## 6. On your phone — two options

### Option A: The native Android app (recommended)
1. **Build the APK** (one-time CI setup):
   - Generate a release keystore locally:
     ```sh
     keytool -genkey -v -keystore agentchat.keystore -alias agentchat \
       -keyalg RSA -keysize 2048 -validity 10000
     ```
   - Base64-encode it and add GitHub **repository secrets**:
     - `ANDROID_KEYSTORE` (base64 of the `.keystore` file)
     - `ANDROID_KEY_ALIAS` (= `agentchat`)
     - `ANDROID_KEY_PASSWORD`
     - `ANDROID_STORE_PASSWORD`
   - Tag a release:
     ```sh
     git tag mobile-v1.0
     git push origin mobile-v1.0
     ```
     The `android-release.yml` workflow builds + signs the APK and uploads it
     to a GitHub Release.
2. **Sideload** the APK from your repo's Releases page (allow "install from
   unknown sources" for your browser).
3. Open the app → enter Server URL (`https://chat.nicoolodion.com`),
   username, password → **Pair**.
4. **Install the ntfy Android app** (Play Store or F-Droid) — this is the
   UnifiedPush *distributor*.
   - In ntfy: Settings → use server URL `https://ntfy.nicoolodion.com`
   - Subscribe to the topic the app gave you at pairing (shown on your
     `/api/mobile/pair` response / Settings screen). The topic is
     `user-<userId>-<random>` — unguessable.
5. When a task finishes, a notification appears. Tapping it opens the task.

### Option B: The `/m` web page (no app needed, PWA)
- Open `https://chat.nicoolodion.com/m` on your phone, log in (cookie auth),
  compose a task, attach files, send. "Add to home screen" in your browser to
  install it as a PWA. Works without the APK at all.

### Verify your email (needed for email results)
- In the Android app **Settings → Verify email**, OR open `/m` and tap the
  locale/email picker. Enter your email address → a verification link is
  sent → click it. Until then, completion emails aren't sent (your address
  isn't confirmed as yours).

---

## 7. Validation — confirm it works end-to-end

1. From `/m` or the app, send a task like *"Bereite mir eine kurze
   Zusammenfassung der letzten Wahlumfragen als PDF und schick es mir per
   Email"*.
2. Watch the desktop sidebar — the task shows as a chat (status
   `running`), same as a normal agent session.
3. On finish: an email arrives at your verified address with the assistant's
   answer + the PDF attached inline. A ntfy push fires on the phone.
4. **Reply** to that email — the IMAP poller picks it up within ~30s,
   appends it as the next user turn on the **same chat**, re-runs the agent,
   and the next answer lands in the same email thread.
5. If you reply from the **desktop UI** instead of by email, the completion
   email/push is suppressed (no double-notify — you're already at the desk).

---

## 8. Treating it as a normal update afterwards

After this one-time setup:
- **Code changes** → `git push origin master` → your Unraid auto-updates app +
  sandbox (the webhook rebuilds + recreates only those two).
- **`.env` changes** → edit the file on Unraid, then `docker compose --profile
  full up -d app` (or `ntfy` if you changed ntfy config).
- **ntfy updates** → the upstream image auto-updates via the deploy webhook?
  No — ntfy is NOT rebuilt/recreated by the deploy webhook. To refresh it:
  ```sh
  docker compose --profile full pull ntfy
  docker compose --profile full up -d ntfy
  ```
- **Database migrations** — included in the deploy (`prisma migrate deploy`
  runs at app startup, or the migration applies on first boot of the new
  image). No manual SQL.
- **New Android release** → tag `mobile-v*`, workflow publishes the APK.

---

## Troubleshooting

| Symptom | Check |
|----|----|
| Task runs but no email | `MAIL_SMTP_HOST` set + valid? Email **verified** in Settings? `answeredFromDesktop` not true? App logs: `docker logs chatinterface-app \| grep -i mail` |
| No push on phone | ntfy reachable at `NTFY_BASE_URL`? Topic subscribed in the ntfy app on the phone? `NTFY_DEFAULT_AUTH` filled? `docker logs chatinterface-ntfy` |
| Email reply doesn't continue | `MAIL_INBOUND_ENABLED=true` + IMAP creds correct? Agent mailbox receives the reply? `docker logs chatinterface-app \| grep -i mailbox` |
| "Could not resolve userKey" | Your session expired (re-login) or neither a `Session` nor a `UserMobileToken` exists for your user. Pair the mobile app or log in via `/m` again. |
| Build fails locally | `APP_ENCRYPTION_KEY`/`SESSION_ENCRYPTION_KEY` must be real 32-byte base64 keys in `.env` (the defaults are rejected in production). |

---

Everything is additive — the existing desktop chat, agent sessions, and
sandbox are untouched. If you never configure mail/ntfy, the app still runs
exactly as before (tasks just complete silently on the server with no
notification).
