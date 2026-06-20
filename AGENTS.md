<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Deployment (do not run your own local-docker build path)

Production images are built by GitHub Actions and published to GHCR; the
production `docker-compose.yml` references prebuilt images only (no `build:`
keys). When changing container-related files, keep this in sync:

- `Dockerfile` (app), `docker-sandbox/Dockerfile` (sandbox), `deploy/Dockerfile`
  (webhook receiver) are the build inputs. CI builds all three for `linux/amd64`
  and tags `latest` plus the commit SHA.
- Image names: `ghcr.io/nicoolodion/agentchat`, `…-agent`, `…-webhook`. If you
  rename a service/image, update `.github/workflows/build-and-deploy.yml` AND
  the `image:` fields in `docker-compose.yml` together.
- Do NOT re-add `build:` to `docker-compose.yml` for production. Local
  building is still available via dev compose files / `npm run dev`.
- The deploy step is a POST to the `deploy-webhook` container through the user's
  reverse proxy (no inbound SSH). `deploy/deploy.sh` updates app + sandbox ONLY
  (never itself — avoids killing its own HTTP response). Webhook image updates
  are manual:
    docker compose --profile full pull deploy-webhook
    docker compose --profile full up -d --no-deps --force-recreate deploy-webhook
- `.env` is gitignored and never overwritten by deploys; env changes are still
  applied by hand on the host. `HOST_DEPLOY_PATH` and `WEBHOOK_SECRET` must be
  set in `.env` (matched by the `WEBHOOK_SECRET` GitHub secret).

Workflow: `.github/workflows/build-and-deploy.yml` (build -> push -> POST to
webhook on push to `master` or manual dispatch).

