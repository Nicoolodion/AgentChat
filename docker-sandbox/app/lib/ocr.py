"""
OCR engine for the Chatinterface Agent sandbox.

Backed by llama.cpp + PaddleOCR-VL-1.6 (GGUF). On first start (run as root by
entrypoint.sh in the background) it:

  1. Downloads the quantized main model + the mmproj projector (and the chat
     template) into /models if they are missing — printed with colored progress.
  2. Downloads a prebuilt llama.cpp release binary (CPU build) for linux/amd64
     into /models/bin if missing.
  3. Launches a persistent `llama-server` detached, bound to 127.0.0.1:LLAMA_PORT,
     loading the model + mmproj. Waits for its /health endpoint.
  4. Writes /models/.ocr-status.json describing readiness.

If any step fails, the status file marks the tool as deactivated (active=false)
together with the error, so the app hides/disables the OCR tool. Nothing here
crashes the sandbox: it is best-effort and degrades gracefully.

The /ocr and /ocr/status HTTP routes in sandbox_server.py call:
  - get_status()   → read status + probe the server
  - handle_ocr()   → rasterize PDFs (pdftoppm) + POST each image to llama-server
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any, Optional

# ── Configuration ────────────────────────────────────────────────────────────

MODELS_DIR = Path(os.environ.get("OCR_MODELS_DIR", "/models"))
BIN_DIR = MODELS_DIR / "bin"

MODEL_FILE = "PaddleOCR-VL-1.6.i1-Q4_K_M.gguf"
MMPROJ_FILE = "PaddleOCR-VL-1.6-GGUF-mmproj.gguf"
TEMPLATE_FILE = "chat_template.jinja"

MODEL_URL = (
    "https://huggingface.co/mradermacher/PaddleOCR-VL-1.6-i1-GGUF/"
    "resolve/main/PaddleOCR-VL-1.6.i1-Q4_K_M.gguf"
)
MMPROJ_URL = (
    "https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/"
    "resolve/main/PaddleOCR-VL-1.6-GGUF-mmproj.gguf"
)
TEMPLATE_URL = (
    "https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/"
    "resolve/main/chat_template.jinja"
)

# llama.cpp prebuilt release (CPU, linux/amd64). Resolved dynamically from the
# GitHub releases API; an explicit override can be set via the env var below.
LLAMA_RELEASE_URL = os.environ.get("LLAMA_RELEASE_URL", "").strip()

LLAMA_SERVER_BIN = BIN_DIR / "llama-server"

STATUS_FILE = MODELS_DIR / ".ocr-status.json"
SERVER_LOG = MODELS_DIR / "llama-server.log"
BOOTSTRAP_LOG = MODELS_DIR / "ocr-bootstrap.log"

LLAMA_PORT = int(os.environ.get("LLAMA_PORT", "8181"))
LLAMA_HOST = "127.0.0.1"
LLAMA_THREADS = int(os.environ.get("LLAMA_THREADS", "4"))
LLAMA_CTX = int(os.environ.get("LLAMA_CTX", "8192"))
SERVER_READY_TIMEOUT = int(os.environ.get("LLAMA_READY_TIMEOUT", "360"))

PDF_DPI = int(os.environ.get("OCR_PDF_DPI", "200"))
MAX_PAGES = int(os.environ.get("OCR_MAX_PAGES", "15"))

# PaddleOCR-VL-1.6 element-level recognition is selected by a FIXED short
# prompt prefix (per the official model card), not by free-form instructions.
# The user message to the model is exactly one of these prefixes + the image;
# no system prompt is used (the card launches llama-server with --temp 0 only).
TASK_PROMPTS: dict[str, str] = {
    "ocr": "OCR:",
    "formula": "Formula Recognition:",
    "table": "Table Recognition:",
    "chart": "Chart Recognition:",
    "seal": "Seal Recognition:",
    "spotting": "Spotting:",
}

# The mmproj defaults to clip.vision.image_max_pixels = 1003520, but the
# 'spotting' task REQUIRES 1605632. We patch the mmproj up to 1605632 once
# during bootstrap so spotting works; the higher cap is safe for the other
# 5 tasks (larger images simply preserve more detail instead of being
# downsampled).
MMPROJ_MAX_PIXELS_KEY = "clip.vision.image_max_pixels"
IMAGES_MAX_PIXELS_SPOTTING = 1605632

OCR_OCR_TIMEOUT = int(os.environ.get("OCR_CALL_TIMEOUT", "180"))

VALID_TASKS = ("ocr", "table", "chart", "formula", "spotting", "seal")

# ── Colored logging ──────────────────────────────────────────────────────────

_USE_COLOR = sys.stdout.isatty() or os.environ.get("OCR_FORCE_COLOR", "1") == "1"

_CODE = {
    "reset": "\033[0m",
    "bold": "\033[1m",
    "dim": "\033[2m",
    "red": "\033[31m",
    "green": "\033[32m",
    "yellow": "\033[33m",
    "blue": "\033[34m",
    "magenta": "\033[35m",
    "cyan": "\033[36m",
    "gray": "\033[90m",
    "bg_blue": "\033[44m",
}


def _c(name: str, text: str) -> str:
    if not _USE_COLOR:
        return text
    code = _CODE.get(name, "")
    return f"{code}{text}{_CODE['reset']}" if code else text


def _ts() -> str:
    return time.strftime("%H:%M:%S")


def log(msg: str, *, level: str = "info") -> None:
    color = {
        "info": "cyan",
        "ok": "green",
        "warn": "yellow",
        "error": "red",
        "step": "blue",
    }.get(level, "cyan")
    tag = level.upper().ljust(5)
    print(f"{_c('dim', _ts())} {_c(color, f'[{tag}]')} {_c('magenta', 'ocr:')} {msg}")


def banner(title: str, subtitle: str = "") -> None:
    bar = "═" * 58
    print()
    print(_c("bg_blue", " " * 60))
    print(_c("bold", f"  {title}"))
    if subtitle:
        print(_c("dim", f"  {subtitle}"))
    print(_c("bg_blue", " " * 60))
    print(_c("cyan", bar))


class OcrUnavailable(Exception):
    """Raised when OCR cannot run (engine unavailable / deactivated)."""


# ── Status file ──────────────────────────────────────────────────────────────

def _default_status() -> dict[str, Any]:
    return {
        "active": False,
        "ready": False,
        "state": "unknown",
        "message": "",
        "errors": [],
        "models": {"main": False, "mmproj": False, "template": False},
        "binary": False,
        "port": LLAMA_PORT,
    }


def _read_status() -> dict[str, Any]:
    try:
        return json.loads(STATUS_FILE.read_text("utf-8"))
    except Exception:
        return _default_status()


def _write_status(data: dict[str, Any]) -> None:
    data["updated_at"] = time.time()
    tmp = STATUS_FILE.with_suffix(".tmp")
    try:
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(data, indent=2), "utf-8")
        tmp.replace(STATUS_FILE)
    except Exception:
        # If /models is read-only (no volume mounted) we cannot persist the
        # flag; fall back to the in-process cached status used by the route.
        _MEM_STATUS.update(data)


_MEM_STATUS: dict[str, Any] = _default_status()


def get_status() -> dict[str, Any]:
    """Return the current OCR status, probing the live server for liveness."""
    data = _read_status()
    # Merge any in-process state (e.g. when the status file is unwritable).
    if _MEM_STATUS and _MEM_STATUS.get("updated_at"):
        data.update({k: v for k, v in _MEM_STATUS.items() if k != "updated_at"})

    live = _probe_server(timeout=2)
    if live:
        data["active"] = True
        data["ready"] = True
        data["state"] = "ready"
        data["message"] = "OCR engine is online."
    else:
        # Keep whatever the bootstrap determined (preparing / deactivated).
        data["active"] = bool(data.get("ready") is True and live)
        if data.get("state") not in ("deactivated", "preparing"):
            if not data.get("ready"):
                data["state"] = "preparing" if data.get("state") != "deactivated" else "deactivated"
        data["active"] = False
    return data


# ── Downloads ────────────────────────────────────────────────────────────────

def _download(url: str, dest: Path, label: str) -> bool:
    """Stream-download `url` to `dest` with colored MB-progress. Idempotent on
    restart via a `.part` file. Returns True on success, False on failure."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "chatinterface-ocr/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            total = resp.headers.get("Content-Length")
            total = int(total) if total else 0
            done = 0
            last_mb = -1
            with open(part, "wb") as f:
                while True:
                    chunk = resp.read(1024 * 1024)  # 1 MiB
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    mb = done // (1024 * 1024)
                    if mb != last_mb:
                        last_mb = mb
                        if total:
                            pct = done * 100 // total if total else 0
                            log(
                                f"downloading {label}  {_c('cyan', str(mb))} / "
                                f"{_c('dim', str(total // (1024*1024)))} MiB "
                                f"({pct}%)",
                                level="info",
                            )
                        else:
                            log(f"downloading {label}  {_c('cyan', str(mb))} MiB", level="info")
        if done < 1024:
            raise OcrUnavailable(f"downloaded file too small ({done} bytes)")
        part.replace(dest)
        log(f"saved {label} → {dest} ({done // (1024*1024)} MiB)", level="ok")
        return True
    except Exception as e:
        try:
            part.unlink(missing_ok=True)
        except Exception:
            pass
        log(f"download failed for {label}: {e}", level="error")
        return False


def ensure_models(status: dict[str, Any]) -> dict[str, Any]:
    """Download the main model, mmproj, and chat template if missing."""
    models = status.setdefault("models", {"main": False, "mmproj": False, "template": False})

    targets = [
        (MODEL_URL, MODELS_DIR / MODEL_FILE, "main model", "main"),
        (MMPROJ_URL, MODELS_DIR / MMPROJ_FILE, "mmproj projector", "mmproj"),
        (TEMPLATE_URL, MODELS_DIR / TEMPLATE_FILE, "chat template", "template"),
    ]
    for url, dest, label, key in targets:
        if dest.exists() and dest.stat().st_size > 1024 * 1024:
            models[key] = True
            log(f"{label} already present ({dest.stat().st_size // (1024*1024)} MiB) — skip", level="ok")
            continue
        log(f"{label} not found, downloading from {url}", level="step")
        ok = _download(url, dest, label)
        models[key] = ok
        if not ok:
            status["errors"].append(f"download failed: {label}")
    return status


def _resolve_llama_release() -> Optional[str]:
    """Find the latest llama.cpp ubuntu-x64 prebuilt zip asset URL."""
    if LLAMA_RELEASE_URL:
        return LLAMA_RELEASE_URL
    try:
        req = urllib.request.Request(
            "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest",
            headers={"User-Agent": "chatinterface-ocr/1.0", "Accept": "application/vnd.github+json"},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.load(resp)
        assets = data.get("assets", []) or []
        # Asset naming: llama-bXXXX-bin-ubuntu-x64.zip
        cands = [a for a in assets if a.get("name", "").endswith("-bin-ubuntu-x64.zip")]
        if not cands:
            # Newer naming sometimes: llama-XXXX-bin-ubuntu-x64.zip
            cands = [a for a in assets if "ubuntu-x64" in a.get("name", "") and a["name"].endswith(".zip")]
        if cands:
            return cands[0]["browser_download_url"]
        log(f"no ubuntu-x64 asset found in release {data.get('tag_name','?')}", level="warn")
    except Exception as e:
        log(f"github releases API failed: {e}", level="warn")
    return None


def ensure_binary(status: dict[str, Any]) -> dict[str, Any]:
    """Download + extract the prebuilt llama.cpp binary if missing."""
    if LLAMA_SERVER_BIN.exists() and os.access(LLAMA_SERVER_BIN, os.X_OK):
        status["binary"] = True
        log(f"llama-server binary already present at {LLAMA_SERVER_BIN}", level="ok")
        return status

    BIN_DIR.mkdir(parents=True, exist_ok=True)
    if not shutil.which("unzip"):
        status["errors"].append("unzip not available to extract llama.cpp release")
        log("unzip is missing — cannot extract llama.cpp", level="error")
        return status

    url = _resolve_llama_release()
    if not url:
        status["errors"].append("could not resolve a llama.cpp release URL")
        log("no llama.cpp release URL resolved — OCR will be deactivated", level="error")
        return status

    zip_path = BIN_DIR / "llama.zip"
    log(f"downloading llama.cpp release: {url}", level="step")
    if not _download(url, zip_path, "llama.cpp release"):
        status["errors"].append("llama.cpp release download failed")
        return status

    try:
        subprocess.run(["unzip", "-o", "-q", str(zip_path), "-d", str(BIN_DIR)],
                       check=True, timeout=120)
    except Exception as e:
        status["errors"].append(f"unzip failed: {e}")
        log(f"unzip failed: {e}", level="error")
        return status
    finally:
        try:
            zip_path.unlink(missing_ok=True)
        except Exception:
            pass

    if not LLAMA_SERVER_BIN.exists():
        # The zip may nest binaries under a subdir; search for it.
        for p in BIN_DIR.rglob("llama-server"):
            try:
                os.chmod(p, 0o755)
                # If found in a subdir, hoist it to BIN_DIR.
                if p != LLAMA_SERVER_BIN:
                    shutil.copy2(p, LLAMA_SERVER_BIN)
                    os.chmod(LLAMA_SERVER_BIN, 0o755)
                break
            except Exception:
                pass

    if not LLAMA_SERVER_BIN.exists():
        status["errors"].append("llama-server not found after extract")
        log("llama-server binary not found after extraction", level="error")
        return status

    try:
        os.chmod(LLAMA_SERVER_BIN, 0o755)
    except Exception:
        pass
    status["binary"] = True
    log(f"llama-server ready at {LLAMA_SERVER_BIN}", level="ok")
    return status


def ensure_mmproj_max_pixels(status: dict[str, Any]) -> dict[str, Any]:
    """Bump the mmproj's ``clip.vision.image_max_pixels`` to 1605632.

    The 'spotting' task REQUIRES this higher cap (the mmproj ships with
    1003520). It is a safe global change: larger images are the only ones
    affected, and they simply keep more detail instead of being downsampled.
    The patch is an in-place mmap write of an existing UINT32 scalar field
    (mirrors llama.cpp's ``gguf_set_metadata.py``), so it is idempotent and
    never rebuilds the file. Non-fatal: if the ``gguf`` package or the field
    is unavailable, OCR still works for the other 5 tasks at the default cap.
    """
    mmproj = MODELS_DIR / MMPROJ_FILE
    if not mmproj.exists():
        return status
    try:
        import gguf  # type: ignore
    except ImportError:
        log("gguf package not installed — cannot raise image_max_pixels "
            "(spotting on large images may be limited)", level="warn")
        return status
    try:
        reader = gguf.GGUFReader(str(mmproj), "r+")
    except Exception as e:
        log(f"cannot open mmproj for patching: {e}", level="warn")
        return status
    field = None
    try:
        field = reader.get_field(MMPROJ_MAX_PIXELS_KEY)
    except Exception:
        field = None
    if field is None:
        log(f"mmproj has no '{MMPROJ_MAX_PIXELS_KEY}' field — skipping patch", level="warn")
        return status
    try:
        handler = reader.gguf_scalar_to_np.get(field.types[0]) if field.types else None
        current = field.parts[field.data[0]][0]
        current_val = int(current)
    except Exception as e:
        log(f"could not read {MMPROJ_MAX_PIXELS_KEY}: {e}", level="warn")
        return status
    if current_val == IMAGES_MAX_PIXELS_SPOTTING:
        log(f"mmproj {MMPROJ_MAX_PIXELS_KEY} already {current_val} — skip patch", level="ok")
        return status
    try:
        new_value = handler(str(IMAGES_MAX_PIXELS_SPOTTING)) if handler else IMAGES_MAX_PIXELS_SPOTTING
        field.parts[field.data[0]][0] = new_value
        log(f"patched mmproj {MMPROJ_MAX_PIXELS_KEY}: {current_val} -> {IMAGES_MAX_PIXELS_SPOTTING}",
            level="ok")
    except Exception as e:
        log(f"failed to patch {MMPROJ_MAX_PIXELS_KEY}: {e}", level="warn")
    return status


# ── llama-server lifecycle ──────────────────────────────────────────────────

def _server_url(path: str) -> str:
    return f"http://{LLAMA_HOST}:{LLAMA_PORT}{path}"


def _probe_server(timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(_server_url("/health"), timeout=timeout) as resp:
            body = resp.read().decode("utf-8", "ignore")
            return "ok" in body.lower() or resp.status == 200
    except Exception:
        return False


def _build_server_argv() -> list[str]:
    # Launch flags mirror the official PaddleOCR-VL llama-server usage:
    #   llama-server -m <model> --mmproj <mmproj> --temp 0
    # The model embeds its own jinja chat template, so we enable --jinja and do
    # NOT override --chat-template (passing the template via argv risks escaping
    # issues / mismatches with the embedded one). The chat_template.jinja we
    # downloaded is kept as a reference artifact but is not needed at runtime.
    argv = [
        str(LLAMA_SERVER_BIN),
        "-m", str(MODELS_DIR / MODEL_FILE),
        "--mmproj", str(MODELS_DIR / MMPROJ_FILE),
        "--host", LLAMA_HOST,
        "--port", str(LLAMA_PORT),
        "-t", str(LLAMA_THREADS),
        "-c", str(LLAMA_CTX),
        "-ngl", "0",
        "--temp", "0",
        "--jinja",
    ]
    return argv


def launch_server(status: dict[str, Any]) -> dict[str, Any]:
    """Start the llama-server detached, wait for readiness, update status."""
    if _probe_server(timeout=2):
        log("llama-server already running on port — reuse", level="ok")
        status["ready"] = True
        status["active"] = True
        status["state"] = "ready"
        return status

    if not status.get("binary"):
        status["ready"] = False
        status["active"] = False
        status["state"] = "deactivated"
        return status

    argv = _build_server_argv()
    log(f"launching llama-server on {LLAMA_HOST}:{LLAMA_PORT} "
        f"(threads={LLAMA_THREADS}, ctx={LLAMA_CTX}, ngl=0)", level="step")

    env = dict(os.environ)
    env["HOME"] = str(MODELS_DIR)
    env["OMP_NUM_THREADS"] = str(LLAMA_THREADS)

    try:
        log_fd = open(SERVER_LOG, "ab", buffering=0)
        log_fd.write(f"\n=== llama-server start {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n".encode())
        subprocess.Popen(
            argv,
            stdout=log_fd,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,  # detach so it survives this process
            env=env,
            close_fds=True,
        )
    except Exception as e:
        status["ready"] = False
        status["active"] = False
        status["state"] = "deactivated"
        status["message"] = f"failed to launch llama-server: {e}"
        status["errors"].append(str(e))
        log(f"failed to launch llama-server: {e}", level="error")
        return status

    # Wait for the model to load and the server to become healthy.
    log(f"waiting for llama-server readiness (up to {SERVER_READY_TIMEOUT}s)…", level="info")
    deadline = time.time() + SERVER_READY_TIMEOUT
    while time.time() < deadline:
        if _probe_server(timeout=3):
            status["ready"] = True
            status["active"] = True
            status["state"] = "ready"
            status["message"] = "OCR engine is online."
            log("llama-server is ready ✓", level="ok")
            return status
        time.sleep(3)

    status["ready"] = False
    status["active"] = False
    status["state"] = "deactivated"
    status["message"] = (
        f"llama-server did not become healthy within {SERVER_READY_TIMEOUT}s "
        f"(see {SERVER_LOG})"
    )
    status["errors"].append(status["message"])
    log("llama-server failed to become healthy", level="error")
    return status


def bootstrap() -> None:
    """Entry point invoked in the background by entrypoint.sh.

    Downloads models + binary, launches the engine, and keeps the status file
    updated. Never raises — always writes a final status so the app can decide.
    """
    banner("Chatinterface OCR — PaddleOCR-VL-1.6", "llama.cpp · CPU")
    status = _default_status()
    status["state"] = "preparing"
    status["message"] = "Preparing OCR engine (downloading / warming up)…"
    _write_status(status)

    # Failing to create /models (read-only rootfs without a volume) → deactivate
    # gracefully rather than crash.
    try:
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        status["state"] = "deactivated"
        status["message"] = f"/models not writable: {e}. Mount a /models volume."
        status["errors"].append(status["message"])
        log(f"/models not writable: {e}", level="error")
        _write_status(status)
        return

    status = ensure_models(status)
    status = ensure_mmproj_max_pixels(status)
    status = ensure_binary(status)
    _write_status(status)

    ready_models = status["models"]["main"] and status["models"]["mmproj"]
    if not (ready_models and status["binary"]):
        status["state"] = "deactivated"
        status["active"] = False
        status["ready"] = False
        status["message"] = "OCR deactivated — model/binary unavailable. " + "; ".join(status["errors"])
        _write_status(status)
        banner_done("OCR DEACTIVATED", "; ".join(status["errors"]) or "model/binary unavailable", err=True)
        return

    status = launch_server(status)
    _write_status(status)
    if status["active"]:
        banner_done("OCR READY", f"llama-server @ {LLAMA_HOST}:{LLAMA_PORT}")
    else:
        banner_done("OCR DEACTIVATED", status.get("message", ""), err=True)


def banner_done(title: str, detail: str = "", *, err: bool = False) -> None:
    bar = "─" * 58
    color = "bg_blue" if not err else "red"
    print(_c(color, " " * 60))
    print(_c("bold", f"  {title}"))
    if detail:
        print(_c("dim", ("  " + detail)[:60]))
    print(_c(color, " " * 60))
    print(_c("gray", bar))


# ── OCR execution ────────────────────────────────────────────────────────────

def _mime_for(path: str) -> str:
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else "png"
    return {
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
        "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp",
        "tif": "image/tiff", "tiff": "image/tiff",
    }.get(ext, "image/png")


def _is_pdf(path: str) -> bool:
    return path.lower().endswith(".pdf")


def rasterize_pdf(pdf_path: str, out_dir: Path, dpi: int = PDF_DPI, max_pages: int = MAX_PAGES) -> list[Path]:
    """Render PDF pages to PNG via pdftoppm (poppler-utils)."""
    pdftoppm = shutil.which("pdftoppm")
    if not pdftoppm:
        raise OcrUnavailable("pdftoppm (poppler-utils) is not available to rasterize PDFs")
    out_dir.mkdir(parents=True, exist_ok=True)
    prefix = out_dir / "page"
    try:
        subprocess.run(
            [pdftoppm, "-r", str(dpi), "-png", "-l", str(max_pages), pdf_path, str(prefix)],
            check=True, capture_output=True, timeout=120,
        )
    except subprocess.CalledProcessError as e:
        raise OcrUnavailable(f"pdftoppm failed: {(e.stderr or b'').decode('utf-8','ignore')[:300]}")
    except subprocess.TimeoutExpired:
        raise OcrUnavailable("pdftoppm timed out while rasterizing the PDF")
    pages = sorted(p for p in out_dir.glob("page-*.png"))
    if not pages:
        # Some pdftoppm builds name files prefix-1.png without the "page-" part.
        pages = sorted(out_dir.glob("*.png"))
    return pages


def run_ocr_image(image_path: str, task: str) -> str:
    """POST one image to the llama-server chat/completions endpoint, return text."""
    if not _probe_server(timeout=3):
        raise OcrUnavailable(
            "OCR engine is not running. It may still be warming up, or "
            "deactivated (check sandbox logs: /models/ocr-bootstrap.log)."
        )
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    mime = _mime_for(image_path)
    data_url = f"data:{mime};base64,{b64}"

    prompt = TASK_PROMPTS[task]
    payload = {
        "model": "paddleocr-vl",
        "messages": [
            {"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_url}},
            ]},
        ],
        "max_tokens": 4096,
        "stream": False,
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        _server_url("/v1/chat/completions"),
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=OCR_OCR_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:500]
        raise OcrUnavailable(f"llama-server HTTP {e.code}: {detail}")
    except Exception as e:
        raise OcrUnavailable(f"llama-server request failed: {e}")

    choices = data.get("choices") or []
    if not choices:
        return data.get("error", {}).get("message", "") or "(no response)"
    return (choices[0].get("message", {}) or {}).get("content", "") or ""


def handle_ocr(input_path: str, task: str) -> dict[str, Any]:
    """Resolve a workspace file to images (rasterizing PDFs), OCR each, combine.

    Runs as root: it may read any session file. Output is the combined text.
    """
    if task not in VALID_TASKS:
        raise OcrUnavailable(f"invalid task '{task}'; must be one of {', '.join(VALID_TASKS)}")
    if not os.path.exists(input_path):
        raise OcrUnavailable(f"input file not found: {input_path}")

    work_dir = Path(input_path).parent
    tmp_dir = Path("/tmp") / f"ocr-{os.getpid()}-{int(time.time() * 1000)}"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    if _is_pdf(input_path):
        pages = rasterize_pdf(input_path, tmp_dir)
        if not pages:
            raise OcrUnavailable("PDF rasterization produced no pages (is the PDF empty?)")
    else:
        pages = [Path(input_path)]

    combined_parts: list[str] = []
    page_results: list[dict[str, Any]] = []
    for i, page in enumerate(pages, 1):
        try:
            text = run_ocr_image(str(page), task)
            page_results.append({"page": i, "text": text, "ok": True})
            if len(pages) > 1:
                combined_parts.append(f"=== Page {i} ===\n{text}")
            else:
                combined_parts.append(text)
        except Exception as e:
            page_results.append({"page": i, "text": "", "ok": False, "error": str(e)})
            combined_parts.append(f"=== Page {i} ===\n[error: {e}]")

    # Best-effort cleanup of rasterized intermediates.
    if _is_pdf(input_path):
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return {
        "task": task,
        "page_count": len(pages),
        "pages": page_results,
        "combined": "\n\n".join(combined_parts),
    }


# ── CLI ──────────────────────────────────────────────────────────────────────

def _cli() -> int:
    if len(sys.argv) < 2:
        print("usage: ocr.py {--bootstrap|--status}", file=sys.stderr)
        return 2
    cmd = sys.argv[1]
    if cmd == "--bootstrap":
        # Output flows to the container stdout so the colored banners appear in
        # `docker logs` (the entrypoint runs this detached with OCR_FORCE_COLOR).
        bootstrap()
        return 0
    if cmd == "--status":
        print(json.dumps(get_status(), indent=2))
        return 0
    if cmd == "--probe":
        return 0 if _probe_server(timeout=5) else 1
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(_cli())
