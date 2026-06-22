"""
Chatinterface Agent Sandbox HTTP API Server
Provides isolated code execution, file operations, and document conversion.
"""

import argparse
import base64
import io
import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import time
import traceback
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from flask import Flask, request, jsonify, Response

# Local helper module (same directory): persistent, streaming, leak-proof
# Python execution. See python_exec.py for details.
from python_exec import run_python

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("sandbox")

app = Flask(__name__)

# Configuration
WORKSPACE_ROOT = Path(os.environ.get("SANDBOX_WORKSPACE", "/workspace"))
MAX_EXECUTION_TIME = int(os.environ.get("SANDBOX_MAX_EXECUTION_TIME", "300"))
DEFAULT_TIMEOUT = int(os.environ.get("SANDBOX_DEFAULT_TIMEOUT", "60"))
MAX_OUTPUT_SIZE = 10 * 1024 * 1024  # 10MB

# Ensure workspace exists
WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)


def make_error(message: str, status_code: int = 400) -> tuple[Response, int]:
    return jsonify({"error": message, "success": False}), status_code


def make_success(data: dict[str, Any]) -> Response:
    return jsonify({"success": True, **data})


def resolve_workspace_path(session_id: str, sub_path: str = "") -> Path:
    """Resolve a path within the session workspace, preventing traversal."""
    session_workspace = WORKSPACE_ROOT / session_id
    session_workspace.mkdir(parents=True, exist_ok=True)

    if sub_path:
        target = (session_workspace / sub_path.lstrip("/")).resolve()
    else:
        target = session_workspace.resolve()

    # Security: prevent path traversal outside workspace
    if not str(target).startswith(str(session_workspace.resolve())):
        raise ValueError("Path traversal detected")

    return target


def ensure_session_dirs(session_id: str) -> Path:
    """Create the standard session directory structure."""
    session_workspace = WORKSPACE_ROOT / session_id
    (session_workspace / "upload").mkdir(parents=True, exist_ok=True)
    (session_workspace / "output").mkdir(parents=True, exist_ok=True)
    (session_workspace / "temp").mkdir(parents=True, exist_ok=True)
    return session_workspace


# ═══════════════════════════════════════════════════════════════════════════════
# Health
# ═══════════════════════════════════════════════════════════════════════════════

@app.route("/health", methods=["GET"])
def health() -> Response:
    """Health check endpoint."""
    checks = {
        "python": True,
        "node": False,
        "playwright": False,
        "libreoffice": False,
        "dotnet": False,
    }

    try:
        subprocess.run(["node", "--version"], capture_output=True, check=True, timeout=5)
        checks["node"] = True
    except Exception:
        pass

    try:
        import playwright
        checks["playwright"] = True
    except ImportError:
        pass

    try:
        subprocess.run(["libreoffice", "--version"], capture_output=True, check=True, timeout=5)
        checks["libreoffice"] = True
    except Exception:
        pass

    try:
        subprocess.run(["dotnet", "--version"], capture_output=True, check=True, timeout=5)
        checks["dotnet"] = True
    except Exception:
        pass

    all_ok = all(checks.values())
    return jsonify({
        "status": "ok" if all_ok else "degraded",
        "checks": checks,
        "workspace_root": str(WORKSPACE_ROOT),
    })


# ═══════════════════════════════════════════════════════════════════════════════
# Python Execution (IPython-like, persistent per session_id)
# ═══════════════════════════════════════════════════════════════════════════════

# Python execution lives in python_exec.run_python (persistent state, real-time
# streaming, process-group timeouts). The routes below just adapt it to HTTP.


@app.route("/exec/python", methods=["POST"])
def exec_python() -> Response:
    """Execute Python code with persistent session state."""
    data = request.get_json(force=True) or {}
    code = data.get("code", "")
    session_id = data.get("session_id", "default")
    timeout = int(data.get("timeout", DEFAULT_TIMEOUT))

    if not code:
        return make_error("Missing 'code' field", 400)

    logger.info(f"[python] session={session_id} timeout={timeout}")

    result = run_python(code, session_id, timeout, WORKSPACE_ROOT)
    return jsonify(result)


@app.route("/exec/python/stream", methods=["POST"])
def exec_python_stream():
    """Stream Python execution output as it happens.

    Emits a JSON object per line:
      {"t":"stdout","s":"..."} / {"t":"stderr","s":"..."}  — live chunks
      {"t":"result", ...}                                   — final result record
    """
    data = request.get_json(force=True) or {}
    code = data.get("code", "")
    session_id = data.get("session_id", "default")
    timeout = int(data.get("timeout", DEFAULT_TIMEOUT))

    if not code:
        return make_error("Missing 'code' field", 400)

    logger.info(f"[python/stream] session={session_id} timeout={timeout}")

    def generate():
        # Run execution in a worker thread; forward live chunks (stdout/stderr
        # lines) through a queue as newline-delimited JSON, then emit the
        # final result record.
        import queue as _q
        import threading as _t

        out_q: "_q.Queue" = _q.Queue()

        def worker():
            def cb(stream, text):
                out_q.put({"t": stream, "s": text})
            try:
                res = run_python(code, session_id, timeout, WORKSPACE_ROOT, on_chunk=cb)
                out_q.put({"t": "result", "data": res})
            except Exception as e:  # pragma: no cover
                out_q.put({"t": "result", "data": {
                    "stdout": "", "stderr": "", "images": [],
                    "error": str(e), "execution_time_ms": 0,
                }})

        th = _t.Thread(target=worker, daemon=True)
        th.start()
        while True:
            item = out_q.get(timeout=timeout + 10)
            yield json.dumps(item) + "\n"
            if item.get("t") == "result":
                break

    return Response(generate(), mimetype="application/x-ndjson")


# ═══════════════════════════════════════════════════════════════════════════════
# Shell Execution
# ═══════════════════════════════════════════════════════════════════════════════

BLACKLISTED_SHELL_PATTERNS = [
    re.compile(r"rm\s+-rf\s+/", re.IGNORECASE),
    re.compile(r"rm\s+-rf\s+/\*", re.IGNORECASE),
    re.compile(r"mkfs\.", re.IGNORECASE),
    re.compile(r":\(\)\{\s*:\|:&\s*\};:", re.IGNORECASE),
    re.compile(r"dd\s+if=/dev/zero", re.IGNORECASE),
    re.compile(r">\s*/dev/sda", re.IGNORECASE),
    re.compile(r"curl\s+.*\|\s*sh", re.IGNORECASE),
    re.compile(r"wget\s+.*\|\s*sh", re.IGNORECASE),
    re.compile(r"base64\s+.*\|\s*sh", re.IGNORECASE),
    re.compile(r"printf\s+.*\|\s*sh", re.IGNORECASE),
    re.compile(r"xargs\s+sh", re.IGNORECASE),
    re.compile(r"eval\s+", re.IGNORECASE),
    re.compile(r"exec\s+sh", re.IGNORECASE),
    re.compile(r"\$\(\s*rm\s", re.IGNORECASE),
    re.compile(r"chmod\s+[0-7]*777", re.IGNORECASE),
    re.compile(r"chown\s+.*root", re.IGNORECASE),
    re.compile(r"/etc/passwd", re.IGNORECASE),
    re.compile(r"/etc/shadow", re.IGNORECASE),
]


def is_shell_blacklisted(command: str) -> bool:
    for pattern in BLACKLISTED_SHELL_PATTERNS:
        if pattern.search(command):
            return True
    return False


@app.route("/exec/shell", methods=["POST"])
def exec_shell() -> Response:
    """Execute a shell command in the session workspace."""
    data = request.get_json(force=True) or {}
    command = data.get("command", "")
    session_id = data.get("session_id", "default")
    working_dir = data.get("working_dir", "")
    timeout = int(data.get("timeout", DEFAULT_TIMEOUT))

    if not command:
        return make_error("Missing 'command' field", 400)

    if is_shell_blacklisted(command):
        return make_error("Command blocked by security policy", 403)

    session_workspace = ensure_session_dirs(session_id)
    cwd = session_workspace
    if working_dir:
        try:
            cwd = resolve_workspace_path(session_id, working_dir)
        except ValueError:
            return make_error("Invalid working directory", 400)

    logger.info(f"[shell] session={session_id} cmd={command[:80]}")

    start = time.time()
    try:
        proc = subprocess.run(
            command,
            shell=True,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=min(timeout, MAX_EXECUTION_TIME),
        )
        duration_ms = int((time.time() - start) * 1000)

        return jsonify({
            "stdout": proc.stdout[-MAX_OUTPUT_SIZE:] if len(proc.stdout) > MAX_OUTPUT_SIZE else proc.stdout,
            "stderr": proc.stderr[-MAX_OUTPUT_SIZE:] if len(proc.stderr) > MAX_OUTPUT_SIZE else proc.stderr,
            "exit_code": proc.returncode,
            "error": None,
            "duration_ms": duration_ms,
        })
    except subprocess.TimeoutExpired as e:
        return jsonify({
            "stdout": e.stdout or "",
            "stderr": e.stderr or "",
            "exit_code": -1,
            "error": f"Command timed out after {timeout}s",
            "duration_ms": int((time.time() - start) * 1000),
        })
    except Exception as e:
        return jsonify({
            "stdout": "",
            "stderr": "",
            "exit_code": -1,
            "error": str(e),
            "duration_ms": int((time.time() - start) * 1000),
        })


# ═══════════════════════════════════════════════════════════════════════════════
# File Operations
# ═══════════════════════════════════════════════════════════════════════════════

SKILLS_ROOT = Path(os.environ.get("SANDBOX_SKILLS_ROOT", "/app/skills"))


@app.route("/file/read", methods=["POST"])
def file_read() -> Response:
    data = request.get_json(force=True) or {}
    file_path = data.get("path", "")
    encoding = data.get("encoding", "utf8")
    session_id = data.get("session_id", "default")

    if not file_path:
        return make_error("Missing 'path' field", 400)

    # Allow reading skill files from /app/skills/ (mounted read-only)
    if file_path.startswith("/app/skills/") or file_path.startswith("skills/"):
        skill_rel = file_path.removeprefix("/app/skills/").removeprefix("skills/")
        target = (SKILLS_ROOT / skill_rel).resolve()
        if not str(target).startswith(str(SKILLS_ROOT.resolve())):
            return make_error("Path traversal detected", 400)
        if not target.exists():
            return make_error("File not found", 404)
        if target.is_dir():
            return make_error("Path is a directory", 400)
        try:
            if encoding == "base64":
                content = base64.b64encode(target.read_bytes()).decode("ascii")
            else:
                content = target.read_text(encoding="utf-8", errors="replace")
            return make_success({
                "content": content,
                "encoding": encoding,
                "size": target.stat().st_size,
                "modified_at": datetime.fromtimestamp(target.stat().st_mtime).isoformat(),
            })
        except Exception as e:
            return make_error(f"Read failed: {e}", 500)

    try:
        target = resolve_workspace_path(session_id, file_path)
    except ValueError:
        return make_error("Invalid path", 400)

    if not target.exists():
        return make_error("File not found", 404)
    if target.is_dir():
        return make_error("Path is a directory", 400)

    try:
        if encoding == "base64":
            content = base64.b64encode(target.read_bytes()).decode("ascii")
        else:
            content = target.read_text(encoding="utf-8", errors="replace")

        return make_success({
            "content": content,
            "encoding": encoding,
            "size": target.stat().st_size,
            "modified_at": datetime.fromtimestamp(target.stat().st_mtime).isoformat(),
        })
    except Exception as e:
        return make_error(f"Read failed: {e}", 500)


@app.route("/file/write", methods=["POST"])
def file_write() -> Response:
    data = request.get_json(force=True) or {}
    file_path = data.get("path", "")
    content = data.get("content", "")
    encoding = data.get("encoding", "utf8")
    session_id = data.get("session_id", "default")

    if not file_path:
        return make_error("Missing 'path' field", 400)

    try:
        target = resolve_workspace_path(session_id, file_path)
    except ValueError:
        return make_error("Invalid path", 400)

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if encoding == "base64":
            target.write_bytes(base64.b64decode(content))
        else:
            target.write_text(content, encoding="utf-8")

        return make_success({
            "path": str(target),
            "size": target.stat().st_size,
        })
    except Exception as e:
        return make_error(f"Write failed: {e}", 500)


@app.route("/file/list", methods=["POST"])
def file_list() -> Response:
    data = request.get_json(force=True) or {}
    dir_path = data.get("path", "/")
    session_id = data.get("session_id", "default")

    # Allow listing skill files from /app/skills/
    if dir_path.startswith("/app/skills/") or dir_path.startswith("skills/"):
        skill_rel = dir_path.removeprefix("/app/skills/").removeprefix("skills/")
        target = (SKILLS_ROOT / skill_rel).resolve() if skill_rel else SKILLS_ROOT.resolve()
        if not str(target).startswith(str(SKILLS_ROOT.resolve())):
            return make_error("Path traversal detected", 400)
        if not target.exists():
            return make_error("Directory not found", 404)
        if not target.is_dir():
            return make_error("Path is not a directory", 400)
        files = []
        try:
            for entry in target.iterdir():
                stat_info = entry.stat()
                mime_type, _ = mimetypes.guess_type(str(entry)) if entry.is_file() else (None, None)
                files.append({
                    "name": entry.name,
                    "path": str(entry),
                    "is_directory": entry.is_dir(),
                    "size": stat_info.st_size if entry.is_file() else 0,
                    "mime_type": mime_type,
                    "modified_at": datetime.fromtimestamp(stat_info.st_mtime).isoformat(),
                })
            files.sort(key=lambda x: (not x["is_directory"], x["name"].lower()))
            return make_success({"files": files})
        except Exception as e:
            return make_error(f"List failed: {e}", 500)

    try:
        target = resolve_workspace_path(session_id, dir_path)
    except ValueError:
        return make_error("Invalid path", 400)

    if not target.exists():
        return make_error("Directory not found", 404)
    if not target.is_dir():
        return make_error("Path is not a directory", 400)

    files = []
    try:
        for entry in target.iterdir():
            stat_info = entry.stat()
            mime_type, _ = mimetypes.guess_type(str(entry)) if entry.is_file() else (None, None)
            files.append({
                "name": entry.name,
                "path": str(entry),
                "is_directory": entry.is_dir(),
                "size": stat_info.st_size if entry.is_file() else 0,
                "mime_type": mime_type,
                "modified_at": datetime.fromtimestamp(stat_info.st_mtime).isoformat(),
            })

        files.sort(key=lambda x: (not x["is_directory"], x["name"].lower()))
        return make_success({"files": files})
    except Exception as e:
        return make_error(f"List failed: {e}", 500)


@app.route("/file/delete", methods=["POST"])
def file_delete() -> Response:
    data = request.get_json(force=True) or {}
    file_path = data.get("path", "")
    session_id = data.get("session_id", "default")

    if not file_path:
        return make_error("Missing 'path' field", 400)

    try:
        target = resolve_workspace_path(session_id, file_path)
    except ValueError:
        return make_error("Invalid path", 400)

    if not target.exists():
        return make_error("File not found", 404)

    try:
        if target.is_dir():
            import shutil
            shutil.rmtree(target)
        else:
            target.unlink()
        return make_success({"deleted": str(target)})
    except Exception as e:
        return make_error(f"Delete failed: {e}", 500)


@app.route("/file/move", methods=["POST"])
def file_move() -> Response:
    data = request.get_json(force=True) or {}
    source = data.get("source", "")
    destination = data.get("destination", "")
    session_id = data.get("session_id", "default")

    if not source or not destination:
        return make_error("Missing 'source' or 'destination' field", 400)

    try:
        src = resolve_workspace_path(session_id, source)
        dst = resolve_workspace_path(session_id, destination)
    except ValueError:
        return make_error("Invalid path", 400)

    if not src.exists():
        return make_error("Source not found", 404)

    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
        return make_success({"source": str(src), "destination": str(dst)})
    except Exception as e:
        return make_error(f"Move failed: {e}", 500)


@app.route("/file/info", methods=["POST"])
def file_info() -> Response:
    data = request.get_json(force=True) or {}
    file_path = data.get("path", "")
    session_id = data.get("session_id", "default")

    if not file_path:
        return make_error("Missing 'path' field", 400)

    try:
        target = resolve_workspace_path(session_id, file_path)
    except ValueError:
        return make_error("Invalid path", 400)

    if not target.exists():
        return make_error("File not found", 404)

    try:
        stat_info = target.stat()
        mime_type, _ = mimetypes.guess_type(str(target)) if target.is_file() else (None, None)
        return make_success({
            "name": target.name,
            "path": str(target),
            "size": stat_info.st_size if target.is_file() else 0,
            "mime_type": mime_type,
            "modified_at": datetime.fromtimestamp(stat_info.st_mtime).isoformat(),
            "is_directory": target.is_dir(),
        })
    except Exception as e:
        return make_error(f"Info failed: {e}", 500)


# ═══════════════════════════════════════════════════════════════════════════════
# Web rendering (Playwright headless) — for JS-heavy SPAs whose static HTML
# is an empty shell. Used as a fallback by the agent's web_fetch tool.
# ═══════════════════════════════════════════════════════════════════════════════

def _block_private_route(url: str) -> bool:
    """Reject private/loopback/internal hosts before launching a browser at them."""
    from urllib.parse import urlparse
    host = (urlparse(url).hostname or "").lower().strip("[]")
    blocked = {"localhost", "metadata.google.internal", "metadata",
              "169.254.169.254", "metadata.aws.internal"}
    if host in blocked:
        return True
    if host.endswith(".internal") or host.endswith(".local") or host.endswith(".localhost"):
        return True
    import re as _re
    v4 = _re.match(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$", host)
    if v4:
        a, b = int(v4.group(1)), int(v4.group(2))
        if a in (0, 10, 127) or (a == 169 and b == 254) or (a == 172 and 16 <= b <= 31) \
                or (a == 192 and b == 168) or (a == 100 and 64 <= b <= 127):
            return True
    if host in ("::1", "::") or host.startswith("fe80:") or host.startswith("fc") or host.startswith("fd"):
        return True
    return False


@app.route("/web/render", methods=["POST"])
def web_render() -> Response:
    """Render a URL with a headless Chromium and return the fully-built HTML.

    Optional:
      - cookies: list of {name, value, domain?, path?} for authenticated
        browsing of user-specified sites.
      - wait_for: a CSS selector to wait for before capturing (default: waits
        for networkidle, capped, then a short timeout).
      - timeout: total seconds (default 35).
    """
    data = request.get_json(force=True) or {}
    url = data.get("url", "")
    cookies = data.get("cookies", []) or []
    wait_for = data.get("wait_for", "")
    timeout = min(int(data.get("timeout", 35)), 90)

    if not url:
        return make_error("Missing 'url' field", 400)
    if not (url.startswith("http://") or url.startswith("https://")):
        return make_error("Only http(s) URLs can be rendered", 400)
    if _block_private_route(url):
        return make_error("Blocked private/internal host", 400)

    logger.info(f"[web/render] url={url[:80]} cookies={len(cookies)} wait_for={wait_for}")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return make_error("Playwright is not installed in the sandbox", 500)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--no-sandbox"])
            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                           "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 1800},
            )
            if cookies:
                norm_cookies = []
                for c in cookies:
                    if not isinstance(c, dict) or not c.get("name") or c.get("value") is None:
                        continue
                    norm_cookies.append({
                        "name": str(c["name"]),
                        "value": str(c["value"]),
                        "domain": c.get("domain") or None,
                        "path": c.get("path") or "/",
                        "httpOnly": bool(c.get("http_only", False)),
                        "secure": bool(c.get("secure", False)),
                    })
                if norm_cookies:
                    try:
                        context.add_cookies(norm_cookies)
                    except Exception as e:
                        logger.warning(f"[web/render] add_cookies failed: {e}")
            page = context.new_page()
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=timeout * 1000)
            except Exception as e:
                browser.close()
                return make_error(f"Navigation failed: {e}", 502)

            try:
                if wait_for:
                    page.wait_for_selector(wait_for, timeout=timeout * 1000)
                else:
                    # Give SPAs time to hydrate / fetch data.
                    try:
                        page.wait_for_load_state("networkidle", timeout=min(timeout, 8) * 1000)
                    except Exception:
                        pass
            except Exception:
                pass

            html = page.content()
            final_url = page.url
            title = page.title()
            content_type = "text/html"
            browser.close()

        return make_success({
            "url": url,
            "final_url": final_url,
            "title": title,
            "content_type": content_type,
            "html": html[:2_000_000],
            "size": len(html),
        })
    except Exception as e:
        return make_error(f"Render failed: {e}", 500)


# ═══════════════════════════════════════════════════════════════════════════════
# DOCX Read (extract structured content from .docx files)
# ═══════════════════════════════════════════════════════════════════════════════

@app.route("/docx/read", methods=["POST"])
def docx_read() -> Response:
    """Parse a .docx file and return structured content (paragraphs, tables, images, styles)."""
    data = request.get_json(force=True) or {}
    file_path = data.get("path", "")
    session_id = data.get("session_id", "default")
    include_images = data.get("include_images", True)
    max_image_width = int(data.get("max_image_width", 800))

    if not file_path:
        return make_error("Missing 'path' field", 400)

    try:
        target = resolve_workspace_path(session_id, file_path)
    except ValueError:
        return make_error("Invalid path", 400)

    if not target.exists():
        return make_error(f"File not found: {file_path}", 404)

    if not str(target).lower().endswith((".docx", ".doc")):
        return make_error("File must be a .docx or .doc file", 400)

    try:
        from docx import Document
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.oxml.ns import qn

        doc = Document(str(target))

        paragraphs = []
        tables = []
        images = []
        image_idx = 0

        # Extract paragraphs with style info
        for i, p in enumerate(doc.paragraphs):
            style_name = p.style.name if p.style else ""
            alignment = ""
            try:
                if p.alignment is not None:
                    alignment_map = {
                        WD_ALIGN_PARAGRAPH.LEFT: "left",
                        WD_ALIGN_PARAGRAPH.CENTER: "center",
                        WD_ALIGN_PARAGRAPH.RIGHT: "right",
                        WD_ALIGN_PARAGRAPH.JUSTIFY: "justify",
                    }
                    alignment = alignment_map.get(p.alignment, "")
            except Exception:
                jc_map = {"left": "left", "start": "left", "center": "center",
                          "right": "right", "end": "right", "justify": "justify",
                          "both": "justify", "distribute": "justify"}
                try:
                    pPr = p._element.find(qn('w:pPr'))
                    if pPr is not None:
                        jc = pPr.find(qn('w:jc'))
                        if jc is not None:
                            val = jc.get(qn('w:val'), '')
                            alignment = jc_map.get(val, val)
                except Exception:
                    alignment = ""
            
            is_heading = style_name.startswith("Heading")
            heading_level = int(style_name.replace("Heading ", "").replace("Heading", "1") or "0") if is_heading else 0
            
            text = p.text.strip()
            
            # Check for inline images in this paragraph
            has_image = False
            for run in p.runs:
                if run._element.xml.find("blip") != -1:
                    has_image = True
                    break
            
            if text or has_image:
                entry = {
                    "index": i,
                    "text": text,
                    "style": style_name,
                    "alignment": alignment,
                    "is_heading": is_heading,
                    "heading_level": heading_level,
                    "has_image": has_image,
                }
                paragraphs.append(entry)

        # Extract tables
        for t_idx, table in enumerate(doc.tables):
            rows = []
            for row in table.rows:
                cells = [cell.text.strip() for cell in row.cells]
                rows.append(cells)
            tables.append({
                "index": t_idx,
                "rows": len(rows),
                "columns": len(rows[0]) if rows else 0,
                "data": rows,
            })

        # Extract images
        if include_images:
            try:
                from docx.opc.constants import RELATIONSHIP_TYPE as RT
                import base64
                
                for rel in doc.part.rels.values():
                    if "image" in rel.reltype:
                        try:
                            image_data = rel.target_part.blob
                            ext = rel.target_part.partname.split(".")[-1] if "." in str(rel.target_part.partname) else "png"
                            mime_map = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "bmp": "image/bmp", "webp": "image/webp", "tiff": "image/tiff", "emf": "image/x-emf", "wmf": "image/x-wmf"}
                            mime = mime_map.get(ext.lower(), "image/png")
                            
                            # Skip EMF/WMF as they can't be displayed in browser
                            if ext.lower() in ("emf", "wmf"):
                                images.append({
                                    "index": image_idx,
                                    "mime_type": mime,
                                    "size": len(image_data),
                                    "extension": ext,
                                    "note": "EMF/WMF format - not displayable as base64",
                                })
                                image_idx += 1
                                continue
                            
                            b64 = base64.b64encode(image_data).decode("ascii")
                            images.append({
                                "index": image_idx,
                                "mime_type": mime,
                                "size": len(image_data),
                                "extension": ext,
                                "data_url": f"data:{mime};base64,{b64[:100]}...",
                            })
                            image_idx += 1
                        except Exception:
                            pass
            except Exception:
                pass

        # Build a readable text summary
        text_parts = []
        for p in paragraphs:
            prefix = "#" * p["heading_level"] + " " if p["is_heading"] else ""
            text_parts.append(f"{prefix}{p['text']}")
        for t in tables:
            text_parts.append(f"\n[Table {t['index']}: {t['rows']}x{t['columns']}]")
            for row in t["data"]:
                text_parts.append(" | ".join(row))
        text_summary = "\n".join(text_parts)

        return make_success({
            "path": file_path,
            "paragraphs": paragraphs,
            "tables": tables,
            "images": images,
            "paragraph_count": len(paragraphs),
            "table_count": len(tables),
            "image_count": len(images),
            "text_summary": text_summary,
        })

    except Exception as e:
        return make_error(f"Failed to parse .docx: {e}", 500)


# ═══════════════════════════════════════════════════════════════════════════════
# DOCX Template Fill (high-level: preserve template layout, replace body content)
# ═══════════════════════════════════════════════════════════════════════════════

@app.route("/docx/template-fill", methods=["POST"])
def docx_template_fill() -> Response:
    """
    Fill a .docx template with new content while preserving the template's
    cover page, tables, headers/footers, and styles.
    
    The agent provides:
    - template_path: path to the template .docx
    - output_path: where to save the result
    - sections: list of {heading, content, images[]} to replace body content
    - keep_cover_page: whether to preserve the first page/table(s)
    - cover_replacements: optional {search: replace} for text in the cover page
    
    This eliminates the need for window-by-window WIR editing when the task is
    "follow this template as an example and create a new document."
    """
    data = request.get_json(force=True) or {}
    session_id = data.get("session_id", "default")
    template_path = data.get("template_path", "")
    output_path = data.get("output_path", "")
    sections = data.get("sections", [])
    keep_cover_page = data.get("keep_cover_page", True)
    cover_replacements = data.get("cover_replacements", {})
    
    if not template_path:
        return make_error("Missing 'template_path' field", 400)
    if not output_path:
        return make_error("Missing 'output_path' field", 400)
    if not sections:
        return make_error("Missing 'sections' field — provide at least one section", 400)
    
    try:
        template_file = resolve_workspace_path(session_id, template_path)
    except ValueError:
        return make_error("Invalid template_path", 400)
    
    if not template_file.exists():
        return make_error(f"Template file not found: {template_path}", 404)
    
    try:
        out_file = resolve_workspace_path(session_id, output_path)
    except ValueError:
        return make_error("Invalid output_path", 400)
    
    out_file.parent.mkdir(parents=True, exist_ok=True)
    session_workspace = ensure_session_dirs(session_id)
    
    try:
        from docx import Document
        from docx.shared import Inches, Pt, Cm, RGBColor
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.oxml.ns import qn
        from docx.oxml import parse_xml as docx_oxml_parse_xml
        docx_Pt = Pt
        import copy
        import re
        
        # Read the template to extract style definitions
        template_doc = Document(str(template_file))
        
        # Create a new document based on the template (this preserves styles)
        # We copy the template then selectively remove body content
        import shutil
        shutil.copy2(str(template_file), str(out_file))
        doc = Document(str(out_file))
        
        # Apply cover page text replacements
        if cover_replacements:
            for search_text, replace_text in cover_replacements.items():
                seen_paragraphs = set()
                for paragraph in doc.paragraphs:
                    if search_text in paragraph.text:
                        pid = id(paragraph._element)
                        if pid not in seen_paragraphs:
                            seen_paragraphs.add(pid)
                            for run in paragraph.runs:
                                if search_text in run.text:
                                    run.text = run.text.replace(search_text, replace_text)
                for table in doc.tables:
                    for row in table.rows:
                        for cell in row.cells:
                            for paragraph in cell.paragraphs:
                                if search_text in paragraph.text:
                                    pid = id(paragraph._element)
                                    if pid not in seen_paragraphs:
                                        seen_paragraphs.add(pid)
                                        for run in paragraph.runs:
                                            if search_text in run.text:
                                                run.text = run.text.replace(search_text, replace_text)
        
        # Determine where the body content starts.
        # Strategy: Find the first element that is NOT part of the cover page.
        # The cover page consists of: the first table (protocol header) and any
        # paragraphs WITHIN/BEFORE that table. Everything after the last cover-page
        # table element is body content and should be removed.
        cover_end_index = 0
        if keep_cover_page:
            body = doc.element.body
            table_elements = body.findall(qn('w:tbl'))
            
            cover_end_elem = None
            
            if table_elements:
                last_cover_table = table_elements[0]
                
                for child in body:
                    if child is last_cover_table:
                        cover_end_elem = child
                        break
                
                if cover_end_elem is not None:
                    found_table = False
                    to_remove = []
                    for child in body:
                        if child is cover_end_elem:
                            found_table = True
                            continue
                        if found_table:
                            to_remove.append(child)
                    
                    for elem in to_remove:
                        body.remove(elem)
        
        # Optional: insert an automatic Table of Contents (built from the
        # headings added below) right after the cover page. Word/LibreOffice
        # populate the page numbers + entry text on open ("update field").
        include_toc = data.get("include_toc", False)
        toc_paragraph = None
        if include_toc:
            toc_paragraph = doc.add_paragraph()
            run = toc_paragraph.add_run()
            # TOC field code: { TOC \o "1-3" \h \z \u } — levels 1-3, hyperlinks.
            fldChar_begin = docx_oxml_parse_xml(
                '<w:fldChar w:fldCharType="begin" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'
            )
            instrText = docx_oxml_parse_xml(
                '<w:instrText xml:space="preserve" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"> TOC \\o "1-3" \\h \\z \\u </w:instrText>'
            )
            fldChar_sep = docx_oxml_parse_xml(
                '<w:fldChar w:fldCharType="separate" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'
            )
            fldChar_end = docx_oxml_parse_xml(
                '<w:fldChar w:fldCharType="end" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'
            )
            run._element.append(fldChar_begin)
            run._element.append(instrText)
            run._element.append(fldChar_sep)
            run._element.append(fldChar_end)
            # Placeholder text so the TOC isn't invisible before first refresh.
            placeholder = doc.add_paragraph(
                "Right-click and choose “Update Field” to build the table of contents."
            )
            try:
                placeholder.runs[0].font.italic = True
                placeholder.runs[0].font.size = docx_Pt(9)
            except Exception:
                pass

        # Now add new content sections
        for section in sections:
            heading = section.get("heading", "")
            content = section.get("content", "")
            images = section.get("images", [])
            
            # Add heading
            if heading:
                heading_level = section.get("heading_level", 1)
                style_name = f"Heading {heading_level}"
                try:
                    h_para = doc.add_heading(heading, level=heading_level)
                except Exception:
                    h_para = doc.add_paragraph(heading)
                    h_para.style = doc.styles[style_name] if style_name in [s.name for s in doc.styles] else None
            
            # Add content (parse simple markdown-like formatting)
            if content:
                lines = content.split('\n')
                prev_was_blank = False
                for line in lines:
                    line_stripped = line.strip()
                    if not line_stripped:
                        if not prev_was_blank:
                            pass
                        prev_was_blank = True
                        continue
                    prev_was_blank = False
                    
                    if line_stripped.startswith('- ') or line_stripped.startswith('* '):
                        text = line_stripped[2:]
                        try:
                            p = doc.add_paragraph(style='List Bullet')
                        except KeyError:
                            p = doc.add_paragraph()
                            run = p.add_run('\u2022 ')
                            run.font.name = 'Symbol'
                        _add_formatted_runs(p, text)
                        continue
                    
                    list_match = re.match(r'^(\d+)[.)]\s+(.*)', line_stripped)
                    if list_match:
                        text = list_match.group(2)
                        try:
                            p = doc.add_paragraph(style='List Number')
                        except KeyError:
                            p = doc.add_paragraph()
                            p.add_run(f'{list_match.group(1)}. ')
                        _add_formatted_runs(p, text)
                        continue
                    
                    heading_match = re.match(r'^(#{1,4})\s+(.*)', line_stripped)
                    if heading_match:
                        level = min(len(heading_match.group(1)), 4)
                        text = heading_match.group(2)
                        try:
                            doc.add_heading(text, level=level + 1)
                        except Exception:
                            doc.add_paragraph(text)
                        continue
                    
                    p = doc.add_paragraph()
                    _add_formatted_runs(p, line_stripped)
            
            # Add images
            for img in images:
                img_path = img.get("path", "")
                img_caption = img.get("caption", "")
                img_width_inches = img.get("width", 5.0)
                
                if not img_path:
                    continue
                
                try:
                    img_file = resolve_workspace_path(session_id, img_path)
                    if img_file.exists():
                        p = doc.add_paragraph()
                        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                        run = p.add_run()
                        run.add_picture(str(img_file), width=Inches(img_width_inches))
                        
                        if img_caption:
                            cap_p = doc.add_paragraph()
                            cap_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                            cap_run = cap_p.add_run(img_caption)
                            cap_run.font.size = Pt(9)
                            cap_run.font.italic = True
                except Exception as e:
                    # Add placeholder if image fails
                    doc.add_paragraph(f"[Image: {img_path} — failed to insert: {e}]")
        
        doc.save(str(out_file))
        
        result_size = out_file.stat().st_size
        
        # Build a summary of what was done
        section_names = [s.get("heading", f"Section {i+1}") for i, s in enumerate(sections)]
        total_images = sum(len(s.get("images", [])) for s in sections)
        
        return make_success({
            "output_path": str(out_file),
            "size": result_size,
            "sections_added": len(sections),
            "section_names": section_names,
            "images_inserted": total_images,
            "cover_preserved": keep_cover_page,
            "cover_replacements_applied": len(cover_replacements),
            "summary": f"Created {output_path} from template {template_path}: {len(sections)} sections, {total_images} images, cover {'preserved' if keep_cover_page else 'not preserved'}",
        })
    
    except Exception as e:
        import traceback
        return make_error(f"Template fill failed: {traceback.format_exc()}", 500)


def _add_formatted_runs(paragraph, text: str):
    """Add runs with **bold** and *italic* formatting to a paragraph."""
    import re
    from docx.shared import Pt
    
    pattern = r'(\*\*.*?\*\*|\*.*?\*)'
    parts = re.split(pattern, text)
    
    for part in parts:
        if not part:
            continue
        if part.startswith('**') and part.endswith('**'):
            run = paragraph.add_run(part[2:-2])
            run.bold = True
        elif part.startswith('*') and part.endswith('*') and not part.startswith('**'):
            run = paragraph.add_run(part[1:-1])
            run.italic = True
        else:
            paragraph.add_run(part)


# ═══════════════════════════════════════════════════════════════════════════════
# DOCX Build (C# + OpenXML SDK creation route)
# ═══════════════════════════════════════════════════════════════════════════════

@app.route("/docx/build", methods=["POST"])
def docx_build() -> Response:
    """Build a DOCX file using the docx skill's C# + OpenXML SDK pipeline."""
    data = request.get_json(force=True) or {}
    session_id = data.get("session_id", "default")
    output_path = data.get("output_path", "")
    program_cs = data.get("program_cs", "")

    if not output_path:
        return make_error("Missing 'output_path' field", 400)

    session_workspace = ensure_session_dirs(session_id)

    try:
        out_file = resolve_workspace_path(session_id, output_path)
    except ValueError:
        return make_error("Invalid output_path", 400)

    out_file.parent.mkdir(parents=True, exist_ok=True)

    # Determine absolute output path for the script
    abs_output = str(out_file)

    # Use the session workspace as the build work dir (writable + executable volume)
    work_dir = session_workspace / ".docx-work"
    work_dir.mkdir(parents=True, exist_ok=True)

    # If program_cs is provided, write it to the work dir
    if program_cs:
        skill_dir = SKILLS_ROOT / "docx"
        # Copy template files if they don't exist
        csproj_src = skill_dir / "assets" / "templates" / "Docx.csproj"
        program_src = skill_dir / "assets" / "templates" / "Program.cs"
        csproj_dst = work_dir / "Docx.csproj"
        program_dst = work_dir / "Program.cs"
        if csproj_src.exists() and not csproj_dst.exists():
            csproj_dst.write_text(csproj_src.read_text(encoding="utf-8"), encoding="utf-8")
        if program_src.exists() and not program_dst.exists():
            program_dst.write_text(program_src.read_text(encoding="utf-8"), encoding="utf-8")
        program_dst.write_text(program_cs, encoding="utf-8")

    docx_script = SKILLS_ROOT / "docx" / "scripts" / "docx"
    if not docx_script.exists():
        return make_error("docx skill script not found at /app/skills/docx/scripts/docx", 500)

    cmd = ["bash", str(docx_script), "build", abs_output]

    env = os.environ.copy()
    env["DOCX_WORK_DIR"] = str(work_dir)
    env["HOME"] = "/tmp"
    env["DOTNET_CLI_HOME"] = "/tmp"
    env["NUGET_PACKAGES"] = "/tmp/nuget"
    env["NUGET_HTTP_CACHE_PATH"] = "/tmp/nuget-http-cache"
    env["NUGET_SCRATCH"] = "/tmp/nuget-scratch"
    env["TMPDIR"] = "/tmp"

    start = time.time()
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
            cwd=str(work_dir),
            env=env,
        )
        duration_ms = int((time.time() - start) * 1000)

        if proc.returncode != 0:
            return make_error(
                f"DOCX build failed:\n{proc.stdout}\n{proc.stderr}", 500
            )

        if not out_file.exists():
            return make_error("DOCX was not generated", 500)

        return make_success({
            "output_path": str(out_file),
            "size": out_file.stat().st_size,
            "duration_ms": duration_ms,
            "stdout": proc.stdout[-MAX_OUTPUT_SIZE:] if len(proc.stdout) > MAX_OUTPUT_SIZE else proc.stdout,
        })
    except subprocess.TimeoutExpired:
        return make_error("DOCX build timed out", 504)
    except Exception as e:
        return make_error(f"DOCX build error: {e}", 500)


# ═══════════════════════════════════════════════════════════════════════════════
# PPTX (PPTD skill) — runs the bundled kimi_pptd binary
# ═══════════════════════════════════════════════════════════════════════════════

# The kimi_pptd runtime ships as a Nuitka-compiled ELF plus sibling .so libs
# under skills/pptx/scripts/runtime/. The skills mount is read-only, and the
# host may not preserve the executable bit (Windows copies, some CI checkouts).
# We therefore use the in-place binary when it is already executable, and fall
# back to a cached, chmod'd copy in /tmp otherwise.
_KIMI_RUNTIME_CACHE = Path("/tmp/kimi_pptd_runtime")


def _resolve_kimi_pptd() -> tuple[Path, Path]:
    """Return (binary_path, runtime_dir) for the kimi_pptd executable,
    preparing a cached executable copy if the mounted binary is not exec."""
    runtime_dir = SKILLS_ROOT / "pptx" / "scripts" / "runtime"
    binary = runtime_dir / "kimi_pptd"
    if not binary.exists():
        raise FileNotFoundError(
            "kimi_pptd binary not found at /app/skills/pptx/scripts/runtime/kimi_pptd"
        )

    # Fast path: mounted binary is already executable (e.g. Docker Desktop).
    if os.access(str(binary), os.X_OK):
        return binary, runtime_dir

    # Fallback: copy the runtime into a writable location and chmod the binary.
    cache_binary = _KIMI_RUNTIME_CACHE / "kimi_pptd"
    ready = _KIMI_RUNTIME_CACHE / ".ready"
    if not ready.exists():
        if _KIMI_RUNTIME_CACHE.exists():
            shutil.rmtree(_KIMI_RUNTIME_CACHE, ignore_errors=True)
        shutil.copytree(runtime_dir, _KIMI_RUNTIME_CACHE)
        os.chmod(cache_binary, 0o755)
        # The bundled python-pptx resolves template XMLs via the relative path
        # pptx/oxml/../templates/*.xml. Nuitka reports the oxml module's path
        # under this tree, so the pptx/oxml/ directory MUST physically exist —
        # otherwise convert/screenshot (which import pptx) fail with
        # FileNotFoundError even though pptx/templates/*.xml are present.
        (_KIMI_RUNTIME_CACHE / "pptx" / "oxml").mkdir(parents=True, exist_ok=True)
        ready.touch()
    return cache_binary, _KIMI_RUNTIME_CACHE


@app.route("/pptx/run", methods=["POST"])
def pptx_run() -> Response:
    """Run a kimi_pptd subcommand (check | convert | screenshot) on a
    workspace file. This is the PPTD skill's execution backend."""
    data = request.get_json(force=True) or {}
    session_id = data.get("session_id", "default")
    action = (data.get("action") or "").strip()
    input_path = data.get("input_path", "")
    output_path = data.get("output_path", "")
    pages = data.get("pages", "")

    if action not in ("check", "convert", "screenshot"):
        return make_error(
            "Invalid 'action'; must be one of check, convert, screenshot", 400
        )
    if not input_path:
        return make_error("Missing 'input_path'", 400)

    ensure_session_dirs(session_id)
    try:
        in_file = resolve_workspace_path(session_id, input_path)
    except ValueError:
        return make_error("Invalid input_path", 400)
    if not in_file.exists():
        return make_error(f"Input file not found: {input_path}", 404)

    out_file: Optional[Path] = None
    if output_path:
        try:
            out_file = resolve_workspace_path(session_id, output_path)
        except ValueError:
            return make_error("Invalid output_path", 400)
        out_file.parent.mkdir(parents=True, exist_ok=True)
        # screenshot writes into a directory; reverse convert (pptx -> pptd)
        # is invoked with a trailing-slash output dir. mirror that.
        if action == "screenshot" or output_path.endswith("/"):
            out_file.mkdir(parents=True, exist_ok=True)

    try:
        binary, runtime_dir = _resolve_kimi_pptd()
    except FileNotFoundError as e:
        return make_error(str(e), 500)

    argv = [str(binary), action, str(in_file)]
    if action in ("convert", "screenshot") and out_file is not None:
        argv += ["-o", str(out_file)]
    if action == "screenshot" and pages:
        argv += ["-p", str(pages)]

    env = os.environ.copy()
    # Match scripts/*.sh locale handling so UTF-8 paths work under POSIX/C.
    env["PYTHONUTF8"] = "1"
    env.setdefault("LC_ALL", "C.UTF-8")
    env.setdefault("LANG", "C.UTF-8")
    # Let the binary resolve its bundled shared libraries relative to itself.
    env["LD_LIBRARY_PATH"] = (
        str(runtime_dir) + os.pathsep + env.get("LD_LIBRARY_PATH", "")
    )

    # Run with cwd = the input file's directory so any (legacy) relative page
    # references resolve against the .pptd's own location.
    start = time.time()
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=300,
            cwd=str(in_file.parent),
            env=env,
        )
        duration_ms = int((time.time() - start) * 1000)

        stdout = proc.stdout or ""
        stderr = proc.stderr or ""
        result: dict[str, Any] = {
            "action": action,
            "exit_code": proc.returncode,
            "stdout": stdout[-MAX_OUTPUT_SIZE:] if len(stdout) > MAX_OUTPUT_SIZE else stdout,
            "stderr": stderr[-MAX_OUTPUT_SIZE:] if len(stderr) > MAX_OUTPUT_SIZE else stderr,
            "duration_ms": duration_ms,
        }

        if out_file is not None and out_file.exists():
            if out_file.is_file():
                result["output_path"] = str(out_file)
                result["size"] = out_file.stat().st_size
            elif action == "screenshot":
                # screenshot directory: list generated images (relative to
                # workspace) so the orchestrator can surface them.
                session_workspace = (WORKSPACE_ROOT / session_id).resolve()
                rel_files: list[str] = []
                for child in sorted(out_file.iterdir()):
                    if child.is_file() and child.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"):
                        try:
                            rel_files.append(str(child.relative_to(session_workspace)))
                        except ValueError:
                            rel_files.append(child.name)
                result["output_dir"] = str(out_file)
                result["images"] = rel_files
            else:
                # reverse convert (pptx -> pptd) produced a project directory.
                result["output_dir"] = str(out_file)

        if proc.returncode != 0:
            return make_error(
                f"kimi_pptd {action} failed (exit {proc.returncode}):\n{stdout}\n{stderr}",
                500,
            )
        return make_success(result)
    except subprocess.TimeoutExpired:
        return make_error(f"kimi_pptd {action} timed out", 504)
    except Exception as e:  # pragma: no cover
        logger.exception("pptx_run error")
        return make_error(f"kimi_pptd {action} error: {e}", 500)


# ═══════════════════════════════════════════════════════════════════════════════
# Conversions
# ═══════════════════════════════════════════════════════════════════════════════

@app.route("/convert/html-to-pdf", methods=["POST"])
def convert_html_to_pdf() -> Response:
    data = request.get_json(force=True) or {}
    input_path = data.get("input_path", "")
    output_path = data.get("output_path", "")
    options = data.get("options", {})
    session_id = data.get("session_id", "default")

    if not input_path or not output_path:
        return make_error("Missing input_path or output_path", 400)

    try:
        in_file = resolve_workspace_path(session_id, input_path)
        out_file = resolve_workspace_path(session_id, output_path)
    except ValueError:
        return make_error("Invalid path", 400)

    if not in_file.exists():
        return make_error("Input HTML file not found", 404)

    out_file.parent.mkdir(parents=True, exist_ok=True)

    # Use Node.js Playwright script for conversion
    script_path = Path("/app/scripts/html_to_pdf.js")
    if not script_path.exists():
        return make_error("html_to_pdf.js script not found", 500)

    cmd = [
        "node", str(script_path),
        str(in_file), str(out_file),
        json.dumps(options),
    ]

    start = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        duration_ms = int((time.time() - start) * 1000)

        if proc.returncode != 0:
            return make_error(f"PDF conversion failed: {proc.stderr}", 500)

        if not out_file.exists():
            return make_error("PDF was not generated", 500)

        return make_success({
            "output_path": str(out_file),
            "size": out_file.stat().st_size,
            "duration_ms": duration_ms,
        })
    except subprocess.TimeoutExpired:
        return make_error("PDF conversion timed out", 504)
    except Exception as e:
        return make_error(f"PDF conversion error: {e}", 500)


@app.route("/convert/docx-to-pdf", methods=["POST"])
def convert_docx_to_pdf() -> Response:
    data = request.get_json(force=True) or {}
    input_path = data.get("input_path", "")
    output_path = data.get("output_path", "")
    session_id = data.get("session_id", "default")

    if not input_path or not output_path:
        return make_error("Missing input_path or output_path", 400)

    try:
        in_file = resolve_workspace_path(session_id, input_path)
        out_file = resolve_workspace_path(session_id, output_path)
    except ValueError:
        return make_error("Invalid path", 400)

    if not in_file.exists():
        return make_error("Input DOCX file not found", 404)

    out_file.parent.mkdir(parents=True, exist_ok=True)

    # Use LibreOffice headless conversion (writable HOME avoids dconf errors)
    out_dir = out_file.parent
    cmd = [
        "libreoffice",
        "--headless",
        "--nologo",
        "--convert-to", "pdf",
        "--outdir", str(out_dir),
        str(in_file),
    ]
    env = os.environ.copy()
    env["HOME"] = "/tmp"

    start = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)
        duration_ms = int((time.time() - start) * 1000)

        # LibreOffice names output based on input filename
        expected_output = out_dir / (in_file.stem + ".pdf")
        if expected_output.exists() and expected_output != out_file:
            expected_output.rename(out_file)

        if not out_file.exists():
            return make_error(f"LibreOffice conversion failed: {proc.stderr}", 500)

        return make_success({
            "output_path": str(out_file),
            "size": out_file.stat().st_size,
            "duration_ms": duration_ms,
        })
    except subprocess.TimeoutExpired:
        return make_error("DOCX to PDF conversion timed out", 504)
    except Exception as e:
        return make_error(f"Conversion error: {e}", 500)


# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Chatinterface Agent Sandbox API")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", type=str, default="0.0.0.0")
    args = parser.parse_args()

    logger.info(f"Starting sandbox server on {args.host}:{args.port}")
    app.run(host=args.host, port=args.port, threaded=True)
