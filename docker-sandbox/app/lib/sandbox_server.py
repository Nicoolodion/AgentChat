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
import subprocess
import sys
import time
import traceback
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from flask import Flask, request, jsonify, Response

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

# In-memory code execution for single-worker mode; for multi-worker, consider
# a persistent kernel process per session managed externally.
SESSION_PYTHON_STATE: dict[str, dict[str, Any]] = {}


def _run_python_single(code: str, session_id: str, timeout: int) -> dict[str, Any]:
    """Execute Python code in a restricted subprocess with captured output."""
    session_workspace = ensure_session_dirs(session_id)

    # Build wrapper script that sets up the environment and captures images
    wrapper_code = f'''
import sys
import json
import base64
import io
import os
import traceback
from contextlib import redirect_stdout, redirect_stderr

os.chdir({str(session_workspace)!r})
os.environ["WORKSPACE_DIR"] = {str(session_workspace)!r}

# Add session-local pip install target to sys.path so packages installed via
# pip_install --target are importable
local_libs = os.path.join({str(session_workspace)!r}, "python_libs")
if local_libs not in sys.path:
    sys.path.insert(0, local_libs)

# Redirect stdout/stderr
out_buffer = io.StringIO()
err_buffer = io.StringIO()

result = {{"stdout": "", "stderr": "", "images": [], "error": None, "execution_time_ms": 0}}

# Try to restore session globals from a persisted file
session_globals = {{}}
globals_file = os.path.join({str(session_workspace)!r}, ".session_globals.json")
if os.path.exists(globals_file):
    try:
        with open(globals_file, "r") as f:
            session_globals = json.load(f)
    except Exception:
        pass

# We can't pickle all objects, but we can keep a simple exec context
exec_globals = {{"__name__": "__main__", **session_globals}}

try:
    start = time.time() if "time" in globals() else 0
    import time as _time
    start = _time.time()

    with redirect_stdout(out_buffer), redirect_stderr(err_buffer):
        exec({code!r}, exec_globals)

    result["execution_time_ms"] = int((_time.time() - start) * 1000)
    result["stdout"] = out_buffer.getvalue()
    result["stderr"] = err_buffer.getvalue()

    # Persist simple globals for next call
    persist_globals = {{}}
    for k, v in exec_globals.items():
        if k.startswith("_"):
            continue
        if k in ("sys", "json", "base64", "io", "os", "traceback", "redirect_stdout", "redirect_stderr"):
            continue
        try:
            json.dumps(v)
            persist_globals[k] = v
        except (TypeError, ValueError):
            pass

    with open(globals_file, "w") as f:
        json.dump(persist_globals, f)

except Exception as e:
    result["error"] = traceback.format_exc()
    result["stdout"] = out_buffer.getvalue()
    result["stderr"] = err_buffer.getvalue()

# Collect any matplotlib images generated
image_dir = os.path.join({str(session_workspace)!r}, ".session_images")
os.makedirs(image_dir, exist_ok=True)
for fname in os.listdir(image_dir):
    fpath = os.path.join(image_dir, fname)
    try:
        with open(fpath, "rb") as img_file:
            b64 = base64.b64encode(img_file.read()).decode("ascii")
            mime = "image/png" if fname.endswith(".png") else "image/jpeg"
            result["images"].append(f"data:{{mime}};base64,{{b64}}")
    except Exception:
        pass

print(json.dumps(result))
'''

    # Run the wrapper in a subprocess for isolation
    cmd = [sys.executable, "-c", wrapper_code]
    start = time.time()
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=min(timeout, MAX_EXECUTION_TIME),
        )
    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": "",
            "images": [],
            "error": f"Execution timed out after {timeout}s",
            "execution_time_ms": int((time.time() - start) * 1000),
        }
    except Exception as e:
        return {
            "stdout": "",
            "stderr": "",
            "images": [],
            "error": str(e),
            "execution_time_ms": int((time.time() - start) * 1000),
        }

    if proc.returncode != 0:
        return {
            "stdout": proc.stdout[-MAX_OUTPUT_SIZE:] if len(proc.stdout) > MAX_OUTPUT_SIZE else proc.stdout,
            "stderr": proc.stderr[-MAX_OUTPUT_SIZE:] if len(proc.stderr) > MAX_OUTPUT_SIZE else proc.stderr,
            "images": [],
            "error": f"Subprocess exited with code {proc.returncode}",
            "execution_time_ms": int((time.time() - start) * 1000),
        }

    # Parse result from stdout
    lines = proc.stdout.strip().splitlines()
    if not lines:
        return {
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "images": [],
            "error": None,
            "execution_time_ms": int((time.time() - start) * 1000),
        }

    try:
        result = json.loads(lines[-1])
        # Prepend any extra stdout before the JSON line
        extra_stdout = "\n".join(lines[:-1])
        if extra_stdout:
            result["stdout"] = extra_stdout + "\n" + result.get("stdout", "")
        return result
    except json.JSONDecodeError:
        return {
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "images": [],
            "error": None,
            "execution_time_ms": int((time.time() - start) * 1000),
        }


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

    result = _run_python_single(code, session_id, timeout)
    return jsonify(result)


# ═══════════════════════════════════════════════════════════════════════════════
# Shell Execution
# ═══════════════════════════════════════════════════════════════════════════════

BLACKLISTED_SHELL_PATTERNS = [
    "rm -rf /",
    "rm -rf /*",
    "mkfs.",
    ":(){ :|:& };:",
    "dd if=/dev/zero",
    "> /dev/sda",
    "curl .*|.*sh",
    "wget .*|.*sh",
]


def is_shell_blacklisted(command: str) -> bool:
    lowered = command.lower()
    for pattern in BLACKLISTED_SHELL_PATTERNS:
        if pattern.lower() in lowered:
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
