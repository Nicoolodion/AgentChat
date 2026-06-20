"""Tiny deploy webhook receiver for Chatinterface.

Listens for POST <host>/deploy with header `X-Webhook-Secret` matching the
WEBHOOK_SECRET env var. On match it runs /app/deploy.sh and returns its output.
Anything else returns 401/404.

Run inside the deploy-webhook container. The container bind-mounts the host
deploy directory at the SAME absolute path it has on the host (so docker
compose, called from here against the host daemon, resolves relative volume
binds correctly). It also mounts /var/run/docker.sock so `docker compose`
talks to the host daemon.
"""

import http.server
import os
import socketserver
import subprocess
import sys
import json

SECRET = os.environ.get("WEBHOOK_SECRET", "")
PATH = os.environ.get("HOST_DEPLOY_PATH", "/repo")
PORT = int(os.environ.get("PORT", "9000"))
TIMEOUT = int(os.environ.get("DEPLOY_TIMEOUT", "1200"))  # 20 min ceiling


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "chatinterface-deploy/1.0"

    def _send(self, code: int, body: str) -> None:
        b = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

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

        env = dict(os.environ)
        env["HOST_DEPLOY_PATH"] = PATH
        try:
            proc = subprocess.run(
                ["/app/deploy.sh"],
                capture_output=True,
                text=True,
                timeout=TIMEOUT,
                env=env,
            )
            body = proc.stdout
            if proc.stderr:
                body += "\n--- stderr ---\n" + proc.stderr
            body = body.rstrip() + f"\n[exit {proc.returncode}]"
            self._send(200 if proc.returncode == 0 else 500, body)
        except subprocess.TimeoutExpired:
            self._send(504, f"deploy timed out after {TIMEOUT}s")
        except Exception as exc:  # noqa: BLE001
            self._send(500, f"receiver error: {exc!r}")

    def do_GET(self):  # noqa: N802
        # Health probe used by docker HEALTHCHECK / reverse proxy tests.
        if self.path.split("?", 1)[0] == "/health":
            info = {"ok": True, "deploy_path": PATH}
            b = json.dumps(info).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        self._send(404, "not found")

    def log_message(self, fmt, *args):  # noqa: A002
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class ThreadingServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    print(f"deploy-webhook: listening on 0.0.0.0:{PORT} "
          f"(deploy_path={PATH})", flush=True)
    with ThreadingServer(("0.0.0.0", PORT), Handler) as httpd:
        httpd.serve_forever()
