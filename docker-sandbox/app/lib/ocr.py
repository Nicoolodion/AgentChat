"""
OCR engine for the Chatinterface Agent sandbox.

Backed by PP-OCRv6_medium (det + rec) via the `paddleocr` package with the
``engine="transformers"`` backend (CPU torch). Runs as a long-lived detached
HTTP server (started in the background by entrypoint.sh) on
127.0.0.1:OCR_PORT; the sandbox API server proxies /ocr calls to it over
localhost HTTP the same way the old llama.cpp engine was proxied. Keeps
/models as the only writable volume (for the status file + the server log);
the model weights themselves are baked read-only into the image under
/app/models/PP-OCRv6_medium_{det,rec}_safetensors/. Nothing is downloaded at
runtime — the engine is fully offline.

The pipeline natively supports two task modes, advertised as OCR tool tasks:
  - "ocr"      — full-text transcription (detection + recognition, reading order).
  - "spotting" — every detected text region with its pixel bbox [x1,y1,x2,y2]
                  and confidence, plus the recognized text.

Both share the same det+rec model run; the only difference is how the
recognized regions are formatted for the agent.

The /ocr and /ocr/status HTTP routes in sandbox_server.py call:
  - get_status()   → read status file + probe the local OCR server
  - handle_ocr()   → forward the file path + task to the OCR subprocess, which
                     rasterizes PDFs (pdftoppm) + runs the pipeline
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Optional

# ── Configuration ────────────────────────────────────────────────────────────

# Writable volume for the readiness status file + the OCR server log. MUST be
# a mounted volume (the image rootfs is read-only); if it isn't writable the
# entrypoint skips the bootstrap and the OCR tool reports deactivated.
MODELS_DIR = Path(os.environ.get("OCR_MODELS_DIR", "/models"))

# Read-only baked-in model weights (det + rec safetensors). Shipped in the
# image, no runtime download. Override for dev/test only.
MODEL_SRC_DIR = Path(os.environ.get("OCR_MODEL_SRC_DIR", "/app/models"))
DET_DIR = MODEL_SRC_DIR / "PP-OCRv6_medium_det_safetensors"
REC_DIR = MODEL_SRC_DIR / "PP-OCRv6_medium_rec_safetensors"

DET_MODEL_NAME = "PP-OCRv6_medium_det"
REC_MODEL_NAME = "PP-OCRv6_medium_rec"

STATUS_FILE = MODELS_DIR / ".ocr-status.json"
SERVER_LOG = MODELS_DIR / "ocr-server.log"
BOOTSTRAP_LOG = MODELS_DIR / "ocr-bootstrap.log"

OCR_PORT = int(os.environ.get("OCR_PORT", os.environ.get("LLAMA_PORT", "8181")))
OCR_HOST = "127.0.0.1"
OCR_DEVICE = os.environ.get("OCR_DEVICE", "cpu").strip() or "cpu"
OCR_THREADS = int(os.environ.get("OCR_THREADS", os.environ.get("LLAMA_THREADS", "4")))
OCR_USE_TEXTLINE_ORIENT = os.environ.get("OCR_USE_TEXTLINE_ORIENTATION", "1") == "1"
SERVER_READY_TIMEOUT = int(os.environ.get("OCR_READY_TIMEOUT", "180"))

PDF_DPI = int(os.environ.get("OCR_PDF_DPI", "200"))
MAX_PAGES = int(os.environ.get("OCR_MAX_PAGES", "15"))

OCR_CALL_TIMEOUT = int(os.environ.get("OCR_CALL_TIMEOUT", "180"))

# Tasks the agent may request. PP-OCRv6_medium (det+rec) genuinely supports
# plain text extraction and text-region spotting with bboxes. Other structured
# tasks (tables/charts/formulas) are NOT supported by this lightweight model —
# the agent is told to use image_analyze for those instead.
VALID_TASKS = ("ocr", "spotting")
VALID_OCR_TASKS = VALID_TASKS  # alias for the subprocess-side handler

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


def banner_done(title: str, detail: str = "", *, err: bool = False) -> None:
    bar = "─" * 58
    color = "bg_blue" if not err else "red"
    print(_c(color, " " * 60))
    print(_c("bold", f"  {title}"))
    if detail:
        print(_c("dim", ("  " + detail)[:60]))
    print(_c(color, " " * 60))
    print(_c("gray", bar))


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
        "engine": "pp-ocrv6-medium",
        "models": {"det": False, "rec": False},
        "port": OCR_PORT,
        "device": OCR_DEVICE,
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
        # If /models is read-only we cannot persist the flag; fall back to the
        # in-process cached status used by the route.
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
        if data.get("state") not in ("deactivated", "preparing"):
            data["state"] = (
                "deactivated" if data.get("state") == "deactivated" else "preparing"
            )
        data["active"] = False
        data["ready"] = False
    return data


# ── Local OCR server probe (gunicorn-side helpers) ───────────────────────────

def _server_url(path: str) -> str:
    return f"http://{OCR_HOST}:{OCR_PORT}{path}"


def _probe_server(timeout: float = 2.0) -> bool:
    try:
        with urllib.request.urlopen(_server_url("/health"), timeout=timeout) as resp:
            if resp.status != 200:
                return False
            body = resp.read().decode("utf-8", "ignore").strip()
            try:
                parsed = json.loads(body)
                return isinstance(parsed, dict) and parsed.get("status") == "ok"
            except (ValueError, TypeError):
                return body == "ok"
    except Exception:
        return False


# ── PDF rasterization (shared by both sides; no heavy deps) ──────────────────

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


# ── OCR execution (gunicorn worker → OCR subprocess over localhost HTTP) ─────

def handle_ocr(input_path: str, task: str) -> dict[str, Any]:
    """Forward a workspace file + task to the local OCR server and return the
    combined OCR result. The subprocess rasterizes PDFs and runs the
    PP-OCRv6 det+rec pipeline once per page; we just proxy the request here so
    the heavy paddleocr/torch imports stay out of the gunicorn worker.
    """
    if task not in VALID_TASKS:
        raise OcrUnavailable(
            f"invalid task '{task}'; must be one of {', '.join(VALID_TASKS)}"
        )
    if not os.path.exists(input_path):
        raise OcrUnavailable(f"input file not found: {input_path}")

    if not _probe_server(timeout=3):
        raise OcrUnavailable(
            "OCR engine is not running. It may still be warming up, or "
            "deactivated (check sandbox logs: /models/ocr-bootstrap.log)."
        )

    body = json.dumps({"input_path": input_path, "task": task}).encode("utf-8")
    req = urllib.request.Request(
        _server_url("/ocr"),
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=OCR_CALL_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", "ignore")
            status = resp.status
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:500]
        raise OcrUnavailable(f"ocr-server HTTP {e.code}: {detail}")
    except Exception as e:
        raise OcrUnavailable(f"ocr-server request failed: {e}")

    try:
        data = json.loads(raw) if raw else {}
    except (ValueError, TypeError):
        raise OcrUnavailable(f"ocr-server returned non-JSON: {raw[:200]}")

    if status != 200:
        msg = data.get("error") or f"ocr-server HTTP {status}"
        raise OcrUnavailable(msg)
    if isinstance(data, dict) and data.get("error"):
        raise OcrUnavailable(str(data["error"]))
    return data


# ── OCR subprocess: pipeline loading + inference ────────────────────────────
# Everything below is imported lazily by the OCR subprocess only (bootstrap() +
# the HTTP server). The gunicorn server never imports paddleocr/torch.

_PIPELINE: Any = None            # paddleocr.PaddleOCR instance
_PIPELINE_LOCK = threading.Lock()
_PIPELINE_ERR: Optional[str] = None
_BOOTSTRAP_LIVE = False          # set True once http server has bound the port


def _verify_local_models() -> tuple[bool, bool, list[str]]:
    """Check the baked-in det/rec safetensors dirs exist with weights."""
    problems: list[str] = []
    det_ok = (DET_DIR / "model.safetensors").is_file() and (DET_DIR / "model.safetensors").stat().st_size > 1024
    rec_ok = (REC_DIR / "model.safetensors").is_file() and (REC_DIR / "model.safetensors").stat().st_size > 1024
    if not det_ok:
        problems.append(f"detection model missing at {DET_DIR}")
    if not rec_ok:
        problems.append(f"recognition model missing at {REC_DIR}")
    return det_ok, rec_ok, problems


def _load_pipeline() -> Any:
    """Import paddleocr lazily and build the OCR pipeline.

    Tries the local safetensors dirs first (offline, baked-in). If the API
    rejects `*_model_dir`, falls back to `model_name` (which auto-downloads
    from HuggingFace on first run, cached under HF_HOME/PP-OCR cache).
    """
    global _PIPELINE_ERR
    from paddleocr import PaddleOCR  # type: ignore  # noqa: local import keeps torch out of gunicorn

    common = dict(
        engine="transformers",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=OCR_USE_TEXTLINE_ORIENT,
        device=OCR_DEVICE,
    )
    last_err: Optional[Exception] = None
    # 1) Local baked-in dirs (preferred: offline, no HF dependency).
    try:
        log(f"loading PP-OCRv6_medium from local dirs (det={DET_DIR}, rec={REC_DIR})", level="step")
        return PaddleOCR(
            text_detection_model_dir=str(DET_DIR),
            text_recognition_model_dir=str(REC_DIR),
            **common,
        )
    except TypeError as e:
        # Older/newer paddleocr API may not accept *_model_dir — fall through.
        last_err = e
        log(f"local model_dir kwarg not accepted ({e}); falling back to model_name", level="warn")
    except Exception as e:
        last_err = e
        log(f"local-dir pipeline load failed: {e}", level="warn")

    # 2) Fallback: HF model_name (auto-download on first use).
    try:
        log(f"loading PP-OCRv6_medium by model_name (will fetch from HF if not cached)", level="step")
        return PaddleOCR(
            text_detection_model_name=DET_MODEL_NAME,
            text_recognition_model_name=REC_MODEL_NAME,
            **common,
        )
    except Exception as e:
        _PIPELINE_ERR = f"pipeline load failed: {e}; earlier: {last_err}"
        raise

    # Unreachable.


def _ensure_pipeline() -> Any:
    """Return the loaded pipeline, loading it on first use under a lock."""
    global _PIPELINE, _PIPELINE_ERR
    with _PIPELINE_LOCK:
        if _PIPELINE is not None:
            return _PIPELINE
        _PIPELINE_ERR = None
        _PIPELINE = _load_pipeline()
        _PIPELINE_ERR = None
        log("PP-OCRv6_medium pipeline ready ✓ (det+rec, transformers engine)", level="ok")
        return _PIPELINE


# ── Result extraction ────────────────────────────────────────────────────────
# PaddleOCR 3.x `pipeline.predict(img)` returns a list of result objects. Each
# result's `.json` (or `.res`) dict exposes per-page:
#   dt_polys  / rec_polys : list of 4-point polygons (shape [N, 4, 2])
#   rec_texts              : list[str]
#   rec_scores             : list[float]
# The exact key set drifts across versions, so probe defensively.

def _result_dict(r: Any) -> dict[str, Any]:
    for attr in ("json", "res"):
        try:
            v = getattr(r, attr, None)
        except Exception:
            v = None
        if isinstance(v, dict):
            return v
        if callable(v):
            try:
                vv = v()
                if isinstance(vv, dict):
                    return vv
            except Exception:
                pass
    # Raw object dict fallback.
    try:
        return dict(r)  # type: ignore[arg-type]
    except Exception:
        return {}


def _as_list(v: Any) -> list[Any]:
    if v is None:
        return []
    try:
        return list(v)
    except TypeError:
        # numpy array
        try:
            return v.tolist()  # type: ignore[union-attr]
        except Exception:
            return []


def _poly_to_bbox(poly: Any) -> list[int]:
    """4-point polygon → axis-aligned bbox [x1,y1,x2,y2]."""
    pts = _as_list(poly)
    xs: list[float] = []
    ys: list[float] = []
    for p in pts:
        plist = _as_list(p)
        if len(plist) >= 2:
            try:
                xs.append(float(plist[0]))
                ys.append(float(plist[1]))
            except (TypeError, ValueError):
                continue
    if not xs or not ys:
        return [0, 0, 0, 0]
    return [int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))]


def _extract_regions(res_dict: dict[str, Any]) -> list[dict[str, Any]]:
    polys = _as_list(res_dict.get("rec_polys") or res_dict.get("dt_polys"))
    texts = _as_list(res_dict.get("rec_texts"))
    scores = _as_list(res_dict.get("rec_scores"))
    n = max(len(polys), len(texts))
    regions: list[dict[str, Any]] = []
    for i in range(n):
        text = ""
        bbox = [0, 0, 0, 0]
        score: float = 0.0
        if i < len(texts):
            text = str(texts[i]) if texts[i] is not None else ""
        if i < len(polys):
            bbox = _poly_to_bbox(polys[i])
        if i < len(scores):
            try:
                score = round(float(scores[i]), 4)
            except (TypeError, ValueError):
                score = 0.0
        regions.append({"bbox": bbox, "score": score, "text": text})
    return regions


def _format_page(regions: list[dict[str, Any]], task: str) -> str:
    if task == "spotting":
        lines = []
        for r in regions:
            x1, y1, x2, y2 = r["bbox"]
            lines.append(
                f"bbox=[{x1},{y1},{x2},{y2}]  score={r['score']:.2f}  text={r['text']!r}"
            )
        return "\n".join(lines) if lines else "(no text regions detected)"
    # "ocr": join recognized line texts (PaddleOCR already sorts in reading order).
    return "\n".join(r["text"] for r in regions if r["text"]) or "(no text detected)"


def _run_image_ocr(image_path: str, task: str) -> tuple[str, list[dict[str, Any]]]:
    """Run the pipeline on one image; return (formatted_text, regions)."""
    pipeline = _ensure_pipeline()
    # PaddleOCR 3.x `predict()` accepts positional `input` only on some
    # versions and `batch_size` only on others; call it positionally to avoid
    # "got an unexpected keyword argument" across API variants.
    try:
        output = pipeline.predict(image_path)
    except TypeError:
        output = pipeline.predict(input=image_path)
    res_dict: dict[str, Any] = {}
    try:
        first = next(iter(output))
        res_dict = _result_dict(first)
    except StopIteration:
        pass
    except Exception:
        pass
    regions = _extract_regions(res_dict)
    return _format_page(regions, task), regions


def _handle_ocr_request(input_path: str, task: str) -> dict[str, Any]:
    """Full OCR of one workspace file (image or PDF). Runs inside the OCR
    subprocess. Resolves work + per-page inference + combines results.
    """
    if task not in VALID_OCR_TASKS:
        raise OcrUnavailable(
            f"invalid task '{task}'; must be one of {', '.join(VALID_OCR_TASKS)}"
        )
    if not os.path.exists(input_path):
        raise OcrUnavailable(f"input file not found: {input_path}")

    tmp_dir = Path("/tmp") / f"ocr-{os.getpid()}-{int(time.time() * 1000)}"
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
            text, regions = _run_image_ocr(str(page), task)
            page_results.append({"page": i, "text": text, "ok": True})
            if len(pages) > 1:
                combined_parts.append(f"=== Page {i} ===\n{text}")
            else:
                combined_parts.append(text)
        except OcrUnavailable:
            raise
        except Exception as e:
            page_results.append({"page": i, "text": "", "ok": False, "error": str(e)})
            combined_parts.append(f"=== Page {i} ===\n[error: {e}]")

    if _is_pdf(input_path):
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return {
        "task": task,
        "page_count": len(pages),
        "pages": page_results,
        "combined": "\n\n".join(combined_parts),
    }


# ── OCR subprocess HTTP server ──────────────────────────────────────────────

class _OcrHandler(BaseHTTPRequestHandler):
    server_version = "ChatinterfaceOCR/1.0"

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def log_message(self, fmt: str, *args: Any) -> None:
        # Quiet the default stderr access logging; we keep our own log file.
        pass

    def do_GET(self) -> None:
        if self.path == "/health" or self.path.startswith("/health?"):
            if _PIPELINE is not None and _PIPELINE_ERR is None:
                self._send(200, {"status": "ok", "engine": "pp-ocrv6-medium",
                                "device": OCR_DEVICE, "tasks": list(VALID_OCR_TASKS)})
            else:
                self._send(503, {"status": "loading", "engine": "pp-ocrv6-medium",
                                 "error": _PIPELINE_ERR or "pipeline not ready"})
            return
        if self.path == "/status" or self.path.startswith("/status?"):
            self._send(200, get_status())
            return
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/ocr":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            req = json.loads(raw.decode("utf-8")) if raw else {}
        except (ValueError, TypeError):
            self._send(400, {"error": "invalid JSON body"})
            return
        input_path = str((req.get("input_path") or "")).strip()
        task = str(req.get("task") or "ocr").strip()
        if not input_path:
            self._send(400, {"error": "missing input_path"})
            return
        # The single-threaded HTTPServer already serializes requests, so no
        # extra locking is needed here — and we must NOT take _PIPELINE_LOCK
        # (it is a non-reentrant lock held while _ensure_pipeline loads the
        # model; _ensure_pipeline is reachable from _handle_ocr_request).
        try:
            result = _handle_ocr_request(input_path, task)
        except OcrUnavailable as e:
            self._send(503, {"error": str(e)})
            return
        except Exception as e:
            tb = traceback.format_exc()
            log(f"ocr inference failed: {e}\n{tb}", level="error")
            self._send(500, {"error": f"ocr inference failed: {e}"})
            return
        self._send(200, result)


def _start_http_server() -> Optional[HTTPServer]:
    """Bind the OCR HTTP server on 127.0.0.1:OCR_PORT. Returns the server
    or None if the port was busy / unavailable."""
    try:
        srv = HTTPServer((OCR_HOST, OCR_PORT), _OcrHandler)
    except OSError as e:
        log(f"could not bind {OCR_HOST}:{OCR_PORT}: {e}", level="error")
        return None
    log(f"OCR server listening on http://{OCR_HOST}:{OCR_PORT}", level="ok")
    return srv


def _tail_log(path: Path, max_bytes: int = 1500) -> str:
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            f.seek(max(0, size - max_bytes))
            return f.read().decode("utf-8", "ignore").strip()
    except Exception:
        return "(log not readable)"


# ── Bootstrap (background process) ──────────────────────────────────────────

def bootstrap() -> None:
    """Entry point invoked in the background by entrypoint.sh.

    Loads the PP-OCRv6 det+rec pipeline (offline, from the baked-in safetensors
    dirs), binds a local HTTP server on 127.0.0.1:OCR_PORT that serves /ocr +
    /health, and keeps the status file updated so the app can decide whether to
    advertise the OCR tool. Never raises — always writes a final status.
    """
    banner("Chatinterface OCR — PP-OCRv6_medium", "paddleocr · transformers · CPU")
    status = _default_status()
    status["state"] = "preparing"
    status["message"] = "Preparing OCR engine (loading PP-OCRv6 det+rec)…"
    _write_status(status)

    try:
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        status["state"] = "deactivated"
        status["message"] = f"/models not writable: {e}. Mount a /models volume."
        status["errors"].append(status["message"])
        log(f"/models not writable: {e}", level="error")
        _write_status(status)
        return

    det_ok, rec_ok, problems = _verify_local_models()
    status["models"] = {"det": det_ok, "rec": rec_ok}
    if problems:
        for p in problems:
            status["errors"].append(p)
        status["state"] = "deactivated"
        status["active"] = False
        status["ready"] = False
        status["message"] = "OCR deactivated — local model weights missing. " + "; ".join(problems)
        _write_status(status)
        banner_done("OCR DEACTIVATED", "; ".join(problems) or "model weights unavailable", err=True)
        return

    # Start the HTTP server NOW so /health can report loading state, then load
    # the pipeline (eager). get_status() probing /health during load gets 503
    # → state stays "preparing"; once loaded, /health returns 200 → "ready".
    global _BOOTSTRAP_LIVE
    srv = _start_http_server()
    if srv is None:
        status["state"] = "deactivated"
        status["message"] = f"could not bind OCR server port {OCR_PORT}"
        status["errors"].append(status["message"])
        _write_status(status)
        banner_done("OCR DEACTIVATED", status["message"], err=True)
        return
    _BOOTSTRAP_LIVE = True

    server_thread = threading.Thread(
        target=_serve_forever, args=(srv,), name="ocr-http", daemon=True
    )
    server_thread.start()

    try:
        _ensure_pipeline()
    except Exception as e:
        status = _read_status()
        status["state"] = "deactivated"
        status["active"] = False
        status["ready"] = False
        status["message"] = f"PP-OCRv6 pipeline load failed: {e}"
        status["errors"].append(status["message"])
        _write_status(status)
        banner_done("OCR DEACTIVATED", status.get("message", ""), err=True)
        # Keep the http server up so /health reports the loading error and the
        # app sees the deactivated state (not a connection refused).
        return

    status = _read_status()
    status["active"] = True
    status["ready"] = True
    status["state"] = "ready"
    status["message"] = "OCR engine is online."
    _write_status(status)
    banner_done("OCR READY", f"pp-ocrv6-medium @ {OCR_HOST}:{OCR_PORT} ({OCR_DEVICE})")

    # The HTTP server thread runs forever (daemon). This process is the
    # OCR server — block here so it doesn't exit.
    try:
        while server_thread.is_alive():
            server_thread.join(timeout=3600)
    except KeyboardInterrupt:
        pass


def _serve_forever(srv: HTTPServer) -> None:
    try:
        srv.serve_forever()
    except Exception as e:
        log(f"http server stopped: {e}", level="error")


# ── CLI ──────────────────────────────────────────────────────────────────────

def _cli() -> int:
    if len(sys.argv) < 2:
        print("usage: ocr.py {--bootstrap|--status|--probe}", file=sys.stderr)
        return 2
    cmd = sys.argv[1]
    if cmd == "--bootstrap":
        # Output flows to the container stdout so the colored banners appear in
        # `docker logs` (the entrypoint runs this detached with OCR_FORCE_COLOR).
        bootstrap()
        # bootstrap() blocks while the server thread lives; reaching here means
        # the server stopped (deactivated port bind / fatal error).
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
