<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Deployment (do not run your own local-docker build path)

Production images are built by GitHub Actions and published to GHCR; the
production `docker-compose.yml` references prebuilt images only (no `build:`
keys). When changing container-related files, keep this in sync:

- `Dockerfile` (app) and `docker-sandbox/Dockerfile` (sandbox) are the build
  inputs. CI builds both for `linux/amd64`+`linux/arm64` and tags `latest` plus
  the commit SHA.
- Image names: `ghcr.io/nicoolodion/agentchat` (app) and
  `ghcr.io/nicoolodion/agentchat-agent` (sandbox). If you rename a service or
  image, update `.github/workflows/build-and-deploy.yml` **and** the
  `image:` fields in `docker-compose.yml` together.
- Do **not** re-add `build:` to `docker-compose.yml` for production. Local
  building is still available via dev compose files / `npm run dev`.
- `.env` is gitignored and never overwritten by deploys; env changes are still
  applied by hand on the host (CI only does `git fetch && git reset --hard` for
  tracked files).

Workflow: `.github/workflows/build-and-deploy.yml` (build → push → SSH deploy on
push to `master` or manual dispatch).

