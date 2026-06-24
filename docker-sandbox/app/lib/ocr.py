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

# Resolved at bootstrap: the directory that must be on LD_LIBRARY_PATH for the
# prebuilt llama-server to find its bundled shared libs (libllama-server-impl.so
# and friends ship next to the binary inside the release archive). The binary
# is run IN PLACE — never hoisted to BIN_DIR — so its sibling .so files stay
# reachable.
_RESOLVED_LIB_PATHS: list[str] = []

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


def _resolve_llama_release() -> Optional[tuple[str, str]]:
    """Find the latest llama.cpp ubuntu-x64 prebuilt asset URL + archive type.

    Returns (url, "tar.gz"|"zip") or None. llama.cpp ships these as
    ``llama-bNNNN-bin-ubuntu-x64.tar.gz`` (current) and historically as
    ``llama-...-bin-ubuntu-x64.zip``; accept both.
    """
    if LLAMA_RELEASE_URL:
        ext = "tar.gz" if LLAMA_RELEASE_URL.endswith(".tar.gz") else "zip"
        return LLAMA_RELEASE_URL, ext
    try:
        req = urllib.request.Request(
            "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest",
            headers={"User-Agent": "chatinterface-ocr/1.0", "Accept": "application/vnd.github+json"},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.load(resp)
        assets = data.get("assets", []) or []
        for ext in (".tar.gz", ".zip"):
            cands = [
                a for a in assets
                if "ubuntu-x64" in a.get("name", "")
                and a.get("name", "").endswith(ext)
            ]
            if cands:
                url = cands[0]["browser_download_url"]
                return url, ("tar.gz" if ext == ".tar.gz" else "zip")
        log(f"no ubuntu-x64 asset found in release {data.get('tag_name','?')} "
            f"(assets: {[a.get('name') for a in assets][:8]})", level="warn")
    except Exception as e:
        log(f"github releases API failed: {e}", level="warn")
    return None


def _resolve_binary() -> tuple[Optional[Path], list[str]]:
    """Locate the extracted llama-server binary and the dirs it needs on its
    library search path.

    The ubuntu prebuilt is NOT a single static binary: it links a bundled
    ``libllama-server-impl.so`` (plus possibly others) that ships alongside the
    executable inside the release archive (e.g. ``.../bin/llama-server`` +
    ``.../lib/*.so``). The binary MUST be run in place with LD_LIBRARY_PATH
    pointing at its sibling lib dirs — hoisting just the executable strands the
    libs and the loader dies with ``cannot open shared object file``.

    Returns (binary_path, [lib_dirs]). Returns (None, []) if not found.
    """
    # 1) Explicitly-marked sentinel for a previously-resolved binary.
    marker = BIN_DIR / ".resolved-binary"
    if marker.exists():
        try:
            data = json.loads(marker.read_text("utf-8"))
            bin_path = Path(data["bin"])
            lib_dirs = [Path(p) for p in data.get("lib_dirs", [])]
            if bin_path.exists() and os.access(bin_path, os.X_OK):
                return bin_path, [str(p) for p in lib_dirs if p.exists()]
        except Exception:
            pass

    # 2) Search the extracted tree for the bare 'llama-server' executable.
    cands = [p for p in BIN_DIR.rglob("llama-server") if p.is_file()]
    if not cands:
        return None, []

    # Drop any stale top-level hoisted copy left by an older (broken) bootstrap
    # that copied the executable to BIN_DIR/llama-server without its libs.
    for c in list(cands):
        if c.parent == BIN_DIR:
            try:
                c.unlink()
            except Exception:
                pass
    cands = [p for p in cands if p.parent != BIN_DIR]
    if not cands:
        return None, []

    # Prefer a binary whose directory (or a sibling lib/) actually contains the
    # bundled .so files — this is the correct in-place executable, not a stray.
    def _lib_score(p: Path) -> int:
        score = 0
        for d in (p.parent, p.parent.parent / "lib", p.parent / "lib"):
            if d.is_dir() and any(d.glob("*.so*")):
                score += 1
        return -score  # higher libs first under min()

    cands.sort(key=_lib_score)
    bin_path = cands[0]
    os.chmod(bin_path, 0o755)
    bin_dir = bin_path.parent

    # Collect candidate lib dirs: a sibling `lib/`, the binary's own dir, and
    # any dir under the extract root that actually contains .so files.
    lib_dirs: list[Path] = []
    for d in [bin_dir, bin_dir.parent / "lib", bin_dir / "lib"]:
        if d.is_dir() and d not in lib_dirs:
            lib_dirs.append(d)
    so_dirs = {p.parent for p in BIN_DIR.rglob("*.so*") if p.is_file()}
    for d in so_dirs:
        if d not in lib_dirs:
            lib_dirs.append(d)

    resolved_libs = [str(d) for d in lib_dirs if d.exists()]
    try:
        marker.write_text(
            json.dumps({"bin": str(bin_path), "lib_dirs": resolved_libs}), "utf-8"
        )
    except Exception:
        pass
    return bin_path, resolved_libs


def ensure_binary(status: dict[str, Any]) -> dict[str, Any]:
    """Download + extract the prebuilt llama.cpp release if missing.

    The binary is run IN PLACE (in its extracted dir) so its bundled shared
    libraries (libllama-server-impl.so etc.) remain reachable; the lib dirs are
    recorded so launch_server can set LD_LIBRARY_PATH.
    """
    global _RESOLVED_LIB_PATHS
    bin_path, lib_paths = _resolve_binary()
    if bin_path is not None:
        _RESOLVED_LIB_PATHS = lib_paths
        status["binary"] = True
        log(f"llama-server binary present at {bin_path}", level="ok")
        if lib_paths:
            log(f"library search path: {os.pathsep.join(lib_paths)}", level="ok")
        globals()["_RESOLVED_BIN"] = bin_path
        return status

    BIN_DIR.mkdir(parents=True, exist_ok=True)
    resolved = _resolve_llama_release()
    if not resolved:
        status["errors"].append("could not resolve a llama.cpp release URL")
        log("no llama.cpp release URL resolved — OCR will be deactivated", level="error")
        return status
    url, arch_ext = resolved
    extractor = "tar" if arch_ext == "tar.gz" else "unzip"
    if not shutil.which(extractor):
        status["errors"].append(f"{extractor} not available to extract llama.cpp release")
        log(f"{extractor} is missing — cannot extract llama.cpp", level="error")
        return status

    archive_path = BIN_DIR / ("llama.tar.gz" if arch_ext == "tar.gz" else "llama.zip")
    log(f"downloading llama.cpp release ({arch_ext}): {url}", level="step")
    if not _download(url, archive_path, f"llama.cpp release ({arch_ext})"):
        status["errors"].append("llama.cpp release download failed")
        return status

    try:
        if arch_ext == "tar.gz":
            subprocess.run(["tar", "xzf", str(archive_path), "-C", str(BIN_DIR)],
                           check=True, timeout=180)
        else:
            subprocess.run(["unzip", "-o", "-q", str(archive_path), "-d", str(BIN_DIR)],
                           check=True, timeout=180)
    except Exception as e:
        status["errors"].append(f"extract failed: {e}")
        log(f"extract failed: {e}", level="error")
        return status
    finally:
        try:
            archive_path.unlink(missing_ok=True)
        except Exception:
            pass

    bin_path, lib_paths = _resolve_binary()
    if bin_path is None:
        status["errors"].append("llama-server not found after extract")
        log("llama-server binary not found after extraction", level="error")
        return status

    _RESOLVED_LIB_PATHS = lib_paths
    globals()["_RESOLVED_BIN"] = bin_path
    status["binary"] = True
    log(f"llama-server ready at {bin_path}", level="ok")
    if lib_paths:
        log(f"library search path: {os.pathsep.join(lib_paths)}", level="ok")
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


def _resolved_bin() -> Path:
    """The actual llama-server executable path (set by ensure_binary).
    Falls back to the legacy BIN_DIR/llama-server path if unset."""
    p = globals().get("_RESOLVED_BIN")
    if p and Path(p).exists():
        return Path(p)
    return LLAMA_SERVER_BIN


def _build_server_argv() -> list[str]:
    # Launch flags mirror the official PaddleOCR-VL llama-server usage:
    #   llama-server -m <model> --mmproj <mmproj> --temp 0
    # The model embeds its own jinja chat template, so we enable --jinja and do
    # NOT override --chat-template (passing the template via argv risks escaping
    # issues / mismatches with the embedded one). The chat_template.jinja we
    # downloaded is kept as a reference artifact but is not needed at runtime.
    argv = [
        str(_resolved_bin()),
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
    # CRITICAL: the prebuilt llama-server is NOT static — it dlopens bundled
    # libs (libllama-server-impl.so) that ship in its sibling lib dirs inside
    # the release archive. Point the loader there so it doesn't die with
    # "cannot open shared object file".
    bin_obj = _resolved_bin()
    if _RESOLVED_LIB_PATHS:
        existing = env.get("LD_LIBRARY_PATH", "")
        env["LD_LIBRARY_PATH"] = os.pathsep.join(
            [p for p in (*_RESOLVED_LIB_PATHS, existing) if p]
        )

    log_fd: Optional[Any] = None
    proc: Optional["subprocess.Popen[bytes]"] = None
    try:
        log_fd = open(SERVER_LOG, "ab", buffering=0)
        log_fd.write(f"\n=== llama-server start {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n".encode())
        # Dump ldd once so a missing-shared-library crash is self-explanatory in
        # the log (the dynamic-loader error otherwise vanishes with the child).
        try:
            ldd = subprocess.run(["ldd", str(bin_obj)],
                                 capture_output=True, text=True, timeout=15,
                                 env=env)
            log_fd.write(b"--- ldd llama-server ---\n")
            log_fd.write(ldd.stdout.encode("utf-8", "ignore"))
            if ldd.stderr.strip():
                log_fd.write(b"\n--- ldd stderr ---\n")
                log_fd.write(ldd.stderr.encode("utf-8", "ignore"))
            log_fd.write(b"\n--- argv ---\n")
            log_fd.write((" ".join(argv) + "\n").encode("utf-8", "ignore"))
        except Exception as e:
            log_fd.write(f"(ldd dump failed: {e})\n".encode("utf-8", "ignore"))
        proc = subprocess.Popen(
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

    # Wait for the model to load and the server to become healthy. Crucially,
    # poll() the child: if it exited (exit 127 = missing shared libs / arch
    # mismatch / bad flags), fail FAST with the actual log tail instead of
    # burning the full 360s readiness budget against a dead process.
    log(f"waiting for llama-server readiness (up to {SERVER_READY_TIMEOUT}s)…", level="info")
    killed_msg: Optional[str] = None
    deadline = time.time() + SERVER_READY_TIMEOUT
    while time.time() < deadline:
        rc = proc.poll()
        if rc is not None:
            tail = _tail_log(SERVER_LOG, 1500)
            suggestion = _suggest_binary_failure(rc, _resolve_lib_ldd(_resolved_bin()), bin_obj=bin_obj)
            killed_msg = (
                f"llama-server exited immediately (code {rc}). "
                f"Likely a missing shared library or libc/arch mismatch. "
                f"Server log tail:\n{tail}"
            )
            status["errors"].append(killed_msg)
            if suggestion:
                status["errors"].append(suggestion)
            log(killed_msg, level="error")
            if suggestion:
                log(suggestion, level="warn")
            break
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
    if killed_msg:
        status["message"] = killed_msg
    else:
        status["message"] = (
            f"llama-server did not become healthy within {SERVER_READY_TIMEOUT}s "
            f"(see {SERVER_LOG})"
        )
    status["errors"].append(status["message"])
    log("llama-server failed to become healthy", level="error")
    return status


def _tail_log(path: Path, max_bytes: int = 1500) -> str:
    """Return the last ~max_bytes of a log file (best-effort, never raises)."""
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            f.seek(max(0, size - max_bytes))
            return f.read().decode("utf-8", "ignore").strip()
    except Exception:
        return "(log not readable)"


def _resolve_lib_ldd(binary: Path) -> str:
    """Return the raw `ldd` output for the llama-server binary (best-effort).

    Runs with LD_LIBRARY_PATH set to the bundled-lib dirs so ldd can resolve the
    private libs (libllama-server-impl.so) that ship next to the binary.
    """
    env = dict(os.environ)
    if _RESOLVED_LIB_PATHS:
        env["LD_LIBRARY_PATH"] = os.pathsep.join(
            [p for p in (*_RESOLVED_LIB_PATHS, env.get("LD_LIBRARY_PATH", "")) if p]
        )
    try:
        r = subprocess.run(["ldd", str(binary)],
                           capture_output=True, text=True, timeout=15, env=env)
        return (r.stdout + ("\n" + r.stderr if r.stderr.strip() else "")).strip()
    except Exception as e:
        return f"(ldd failed: {e})"


def _suggest_binary_failure(exit_code: Optional[int], ldd_output: str, bin_obj: Path) -> str:
    """Inspect ldd output for the classic 'not found' shared-library lines and
    return the list of missing libs so the operator can install them. Empty
    string when nothing actionable is found."""
    if exit_code == 127:
        # 127 with a present + executable ELF almost always means a missing .so.
        missing: list[str] = []
        for line in ldd_output.splitlines():
            low = line.strip().lower()
            if "not found" in low and "=>" in line:
                lib = line.split("=>")[0].strip()
                if lib:
                    missing.append(lib)
        hint = (
            f"llama-server ({bin_obj}, exit 127) is present but cannot run — most "
            "likely a missing shared library. If the missing lib is a bundled "
            "one (libllama-server-impl.so etc.), ensure LD_LIBRARY_PATH includes "
            "its sibling lib dir; otherwise install the debian package providing "
            "each missing lib in docker-sandbox/Dockerfile. Missing libs detected:"
        )
        if missing:
            return f"{hint}\n  " + "\n  ".join(missing) + f"\n\nFull ldd:\n{ldd_output}"
        return f"{hint} (none parsed from ldd; run `ldd` manually).\nFull ldd:\n{ldd_output}"
    return ""


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
