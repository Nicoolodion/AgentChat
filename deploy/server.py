"""Tiny deploy webhook receiver for Chatinterface.

Listens for POST <host>/deploy with header `X-Webhook-Secret` matching the
WEBHOOK_SECRET env var. On match it starts /app/deploy.sh in a BACKGROUND
thread and returns 202 Accepted immediately with a run id, so the HTTP client
(GitHub Actions / reverse proxy) never hits its request timeout while a slow
docker-compose recreation is in flight.

Status & logs can then be polled via:
    GET /deploy/status[?run=<id>]   -> JSON: {run_id, status, returncode, ...}
    GET /deploy/log[?run=<id>]      -> text/plain full output (stdout+stderr)

Anything else returns 401/404. GET /health is the docker HEALTHCHECK probe.

IMPORTANT: this receiver deliberately does NOT recreate itself, so the
foreground deploy-webhook container stays up across deploys. Run inside the
deploy-webhook container, which bind-mounts the host deploy directory at the
SAME absolute path it has on the host (so docker compose, called from here
against the host daemon via the mounted /var/run/docker.sock, resolves
relative volume binds correctly).
"""

import http.server
import json
import os
import socketserver
import subprocess
import sys
import threading
import time
import traceback
import uuid
from typing import Optional

SECRET = os.environ.get("WEBHOOK_SECRET", "")
PATH = os.environ.get("HOST_DEPLOY_PATH", "/repo")
PORT = int(os.environ.get("PORT", "9000"))
TIMEOUT = int(os.environ.get("DEPLOY_TIMEOUT", "1200"))  # 20 min ceiling
LOG_DIR = os.environ.get("DEPLOY_LOG_DIR", "/app/logs")

# ── Concurrency + run-state ──────────────────────────────────────────────────

_deploy_lock = threading.Lock()
_latest_run_id: Optional[str] = None


def _run_file(run_id: str, suffix: str) -> str:
    return os.path.join(LOG_DIR, f"{run_id}.{suffix}")


def _write_status(run_id: str, status: dict) -> None:
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        with open(_run_file(run_id, "status.json"), "w", encoding="utf-8") as f:
            json.dump(status, f, indent=2)
        # The "latest" pointer is always overwritten so a fresh receiver
        # process can still report the most recent run without in-memory state.
        with open(os.path.join(LOG_DIR, "latest.json"), "w", encoding="utf-8") as f:
            json.dump({"run_id": run_id, **status}, f, indent=2)
    except Exception:  # noqa: BLE001
        # Status persistence is best-effort; never let it crash a deploy.
        traceback.print_exc()


def _read_latest() -> dict:
    try:
        with open(os.path.join(LOG_DIR, "latest.json"), encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def _run_deploy(run_id: str) -> None:
    started_at = time.time()
    _write_status(run_id, {
        "run_id": run_id,
        "status": "running",
        "started_at": started_at,
        "finished_at": None,
        "returncode": None,
        "log_path": _run_file(run_id, "log"),
    })
    env = dict(os.environ)
    env["HOST_DEPLOY_PATH"] = PATH
    try:
        os.makedirs(LOG_DIR, exist_ok=True)
        log_fp = open(_run_file(run_id, "log"), "w", encoding="utf-8")
        try:
            proc = subprocess.run(
                ["/app/deploy.sh"],
                stdout=log_fp,
                stderr=subprocess.STDOUT,
                timeout=TIMEOUT,
                env=env,
            )
            rc = proc.returncode
            _write_status(run_id, {
                "run_id": run_id,
                "status": "success" if rc == 0 else "failed",
                "started_at": started_at,
                "finished_at": time.time(),
                "returncode": rc,
                "log_path": _run_file(run_id, "log"),
            })
        finally:
            log_fp.close()
    except subprocess.TimeoutExpired:
        _write_status(run_id, {
            "run_id": run_id,
            "status": "timeout",
            "started_at": started_at,
            "finished_at": time.time(),
            "returncode": None,
            "log_path": _run_file(run_id, "log"),
            "error": f"deploy timed out after {TIMEOUT}s",
        })
    except Exception as exc:  # noqa: BLE001
        _write_status(run_id, {
            "run_id": run_id,
            "status": "error",
            "started_at": started_at,
            "finished_at": time.time(),
            "returncode": None,
            "log_path": _run_file(run_id, "log"),
            "error": repr(exc),
        })
    finally:
        _deploy_lock.release()


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "chatinterface-deploy/1.1"

    def _send(self, code: int, body: str, ctype: str = "text/plain; charset=utf-8") -> None:
        b = body.encode("utf-8") if isinstance(body, str) else body
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
        except BrokenPipeError:
            # Client (GitHub Actions / proxy) closed the connection before we
            # finished writing. Nothing we can do — log and move on.
            sys.stderr.write("client closed connection before response completed\n")
        except ConnectionResetError:
            sys.stderr.write("client reset connection\n")

    def _send_json(self, code: int, obj: dict) -> None:
        self._send(code, json.dumps(obj, indent=2), "application/json")

    # ── Deploy trigger ───────────────────────────────────────────────────────
    def do_POST(self):  # noqa: N802 (http.server API)
        if self.path.split("?", 1)[0] != "/deploy":
            self._send(404, "not found")
            return
        if not SECRET:
            self._send(500, "WEBHOOK_SECRET is not set on the receiver")
            return
        token = self.headers.get("X-Webhook-Secret", "")
        # Constant-time-ish compare; secret is high-entropy so timing is moot.
        if token != SECRET:
            self._send(401, "unauthorized")
            return

        # Block overlapping deploys: if one is already running, reject.
        if not _deploy_lock.acquire(blocking=False):
            latest = _read_latest()
            self._send_json(409, {
                "ok": False,
                "status": "busy",
                "message": "another deploy is already running",
                "current": latest,
            })
            return

        run_id = f"{int(time.time())}-{uuid.uuid4().hex[:8]}"
        global _latest_run_id
        _latest_run_id = run_id
        thread = threading.Thread(target=_run_deploy, args=(run_id,), daemon=True)
        thread.start()

        self._send_json(202, {
            "ok": True,
            "status": "accepted",
            "run_id": run_id,
            "message": "deploy started; poll GET /deploy/status",
            "status_url": f"/deploy/status?run={run_id}",
            "log_url": f"/deploy/log?run={run_id}",
        })

    # ── Status / log polling + health ────────────────────────────────────────
    def do_GET(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        params = dict(p.split("=", 1) for p in query.split("&") if "=" in p) if query else {}

        if path == "/health":
            self._send_json(200, {"ok": True, "deploy_path": PATH})
            return

        if path == "/deploy/status":
            if self.headers.get("X-Webhook-Secret", "") != SECRET:
                self._send(401, "unauthorized")
                return
            run_id = params.get("run") or _latest_run_id
            if run_id:
                try:
                    with open(_run_file(run_id, "status.json"), encoding="utf-8") as f:
                        self._send_json(200, json.load(f))
                        return
                except FileNotFoundError:
                    self._send_json(404, {"ok": False, "status": "not_found",
                                          "run_id": run_id})
                    return
                except Exception as exc:  # noqa: BLE001
                    self._send_json(500, {"ok": False, "error": repr(exc)})
                    return
            latest = _read_latest()
            if latest:
                self._send_json(200, latest)
                return
            self._send_json(200, {"ok": True, "status": "idle",
                                 "message": "no deploys have run yet"})
            return

        if path == "/deploy/log":
            if self.headers.get("X-Webhook-Secret", "") != SECRET:
                self._send(401, "unauthorized")
                return
            run_id = params.get("run") or _latest_run_id
            if not run_id:
                latest = _read_latest()
                run_id = latest.get("run_id")
            if not run_id:
                self._send(404, "no deploy logs available")
                return
            try:
                with open(_run_file(run_id, "log"), encoding="utf-8") as f:
                    self._send(200, f.read())
                return
            except FileNotFoundError:
                self._send(404, f"no log for run {run_id}")
                return
            except Exception as exc:  # noqa: BLE001
                self._send(500, f"log read error: {exc!r}")
                return

        self._send(404, "not found")

    def log_message(self, fmt, *args):  # noqa: A002
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class ThreadingServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    os.makedirs(LOG_DIR, exist_ok=True)
    print(f"deploy-webhook: listening on 0.0.0.0:{PORT} "
          f"(deploy_path={PATH}, log_dir={LOG_DIR})", flush=True)
    with ThreadingServer(("0.0.0.0", PORT), Handler) as httpd:
        httpd.serve_forever()
