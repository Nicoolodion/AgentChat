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
                for paragraph in doc.paragraphs:
                    if search_text in paragraph.text:
                        for run in paragraph.runs:
                            if search_text in run.text:
                                run.text = run.text.replace(search_text, replace_text)
                # Also check tables on cover page
                for table in doc.tables:
                    for row in table.rows:
                        for cell in row.cells:
                            for paragraph in cell.paragraphs:
                                if search_text in paragraph.text:
                                    for run in paragraph.runs:
                                        if search_text in run.text:
                                            run.text = run.text.replace(search_text, replace_text)
        
        # Determine where the body content starts.
        # Strategy: find the first heading after the cover page, or the first
        # paragraph after all cover-page tables, then remove everything from there.
        cover_end_index = 0
        if keep_cover_page:
            # Find tables in the document body
            body = doc.element.body
            table_elements = body.findall(qn('w:tbl'))
            
            # Find the index of the last element that's part of the cover page.
            # Heuristic: the cover page ends after the last table that appears
            # before any Heading 1 style paragraph.
            found_heading = False
            cover_end_elem = None
            
            for child in body:
                tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                
                # Check if this is a heading paragraph
                if tag == 'p':
                    pPr = child.find(qn('w:pPr'))
                    if pPr is not None:
                        pStyle = pPr.find(qn('w:pStyle'))
                        if pStyle is not None:
                            style_val = pStyle.get(qn('w:val'), '')
                            if style_val.startswith('Heading') or style_val.startswith('heading'):
                                found_heading = True
                                cover_end_elem = child
                                break
                    
                    # Also check for explicit section markers in German protocols
                    text_elem = child.find(qn('w:r'))
                    if text_elem is not None:
                        t_elem = text_elem.find(qn('w:t'))
                        if t_elem is not None and t_elem.text:
                            text = t_elem.text.strip()
                            if text in ('Übungsangabe', 'Aufgabenstellung', 'Stoffwiederholung', 
                                       'Übungsablauf', 'Exercise', 'Task', 'Procedure'):
                                found_heading = True
                                cover_end_elem = child
                                break
                
                # Tables before the first heading are part of the cover page
                if tag == 'tbl' and not found_heading:
                    cover_end_elem = child
            
            if not found_heading:
                # No heading found — assume the entire document is cover + body
                # Keep just the first table (cover table) if any
                if table_elements:
                    cover_end_elem = table_elements[0]
        
        # Remove body content after cover page
        if cover_end_elem is not None:
            body = doc.element.body
            found_cover_end = False
            to_remove = []
            for child in body:
                if child is cover_end_elem:
                    found_cover_end = True
                    to_remove.append(child)
                    continue
                if found_cover_end:
                    to_remove.append(child)
            
            for elem in to_remove:
                body.remove(elem)
        
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
                for line in lines:
                    line_stripped = line.strip()
                    if not line_stripped:
                        doc.add_paragraph('')
                        continue
                    
                    # Bullet list
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
                            num_run = p.add_run(f'{list_match.group(1)}. ')
                        _add_formatted_runs(p, text)
                        continue
                    
                    # Sub-heading (### or ##)
                    heading_match = re.match(r'^(#{1,4})\s+(.*)', line_stripped)
                    if heading_match:
                        level = min(len(heading_match.group(1)), 4)
                        text = heading_match.group(2)
                        try:
                            doc.add_heading(text, level=level + 1)  # +1 since Heading 1 is the main section
                        except Exception:
                            doc.add_paragraph(text)
                        continue
                    
                    # Regular paragraph
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
