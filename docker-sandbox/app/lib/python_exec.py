"""
Persistent, streaming, leak-proof Python execution for the agent sandbox.

Each session keeps its variables across calls by serializing the interpreter
globals to disk (dill when available, JSON fallback) between executions.

A fresh `python -c` subprocess runs each code block under its own OS process
group (``start_new_session=True``). On timeout the *whole process group* is
killed (SIGKILL), so child processes the user's code spawned (multiprocessing,
``subprocess.Popen``, C threads holding the GIL) are cleaned up reliably
instead of leaking.

Output is streamed line-by-line in real time. The wrapper marks its final
result JSON with a sentinel token so the manager can distinguish code output
from the result record.
"""

import base64
import io
import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

MAX_OUTPUT_SIZE = 10 * 1024 * 1024  # 10MB
MAX_EXECUTION_TIME = int(os.environ.get("SANDBOX_MAX_EXECUTION_TIME", "300"))

# Sentinel wrapping the final result JSON. Uses an unlikely byte sequence so
# user output is never mistaken for the result record.
_RESULT_TOKEN = "\x1e__SANDBOX_RESULT__\x1e"


def ensure_session_dirs(session_id: str, workspace_root: Path) -> Path:
    session_workspace = workspace_root / session_id
    for sub in ("upload", "output", "temp"):
        (session_workspace / sub).mkdir(parents=True, exist_ok=True)
    return session_workspace


def _build_wrapper(code: str, session_workspace: Path) -> str:
    """Build the Python wrapper script that runs user code and prints a
    sentinel-delimited result JSON as its final line.

    User ``print()`` output goes straight to the real stdout (flushed) so the
    manager can stream it as it happens. The wrapper only redirects stderr to a
    buffer (so tracebacks/warnings are captured into the result) and writes
    the final result via the sentinel.
    """
    ws = str(session_workspace)
    local_libs = os.path.join(ws, "python_libs")
    return f'''
import sys, json, base64, io, os, traceback, time

os.chdir({ws!r})
os.environ["WORKSPACE_DIR"] = {ws!r}

local_libs = {local_libs!r}
if local_libs not in sys.path:
    sys.path.insert(0, local_libs)

TOKEN = {_RESULT_TOKEN!r}

# Restore persisted globals from the previous call.
exec_globals = {{"__name__": "__main__", "__builtins__": __builtins__}}
state_file = os.path.join({ws!r}, ".session_state.pkl")
json_state_file = os.path.join({ws!r}, ".session_globals.json")

restored = {{}}
try:
    import dill  # type: ignore
    if os.path.exists(state_file):
        with open(state_file, "rb") as f:
            restored = dill.load(f) or {{}}
except Exception:
    restored = {{}}
# JSON fallback (kept for backward-compat with sessions created before dill).
if not restored and os.path.exists(json_state_file):
    try:
        with open(json_state_file, "r") as f:
            restored = json.load(f)
    except Exception:
        restored = {{}}
if restored:
    for _k, _v in restored.items():
        exec_globals[_k] = _v

err_buffer = io.StringIO()

result = {{"stdout": "", "stderr": "", "images": [], "error": None,
           "execution_time_ms": 0, "persisted_count": 0}}

# Real-time stdout: user prints go to the real stdout, flushed per write
# (`-u` + explicit flush). We do NOT redirect stdout so streaming works.
real_stdout = sys.stdout

class FlushingStream:
    def __init__(self, underlying):
        self.underlying = underlying
    def write(self, s):
        n = self.underlying.write(s)
        try:
            self.underlying.flush()
        except Exception:
            pass
        return n
    def flush(self):
        try:
            self.underlying.flush()
        except Exception:
            pass
    def isatty(self):
        return getattr(self.underlying, "isatty", lambda: False)()

sys.stdout = FlushingStream(sys.__stdout__)

import time as _time
start = _time.time()
try:
    old_stderr = sys.stderr
    sys.stderr = err_buffer
    try:
        exec({code!r}, exec_globals)
    finally:
        sys.stderr = old_stderr

    result["execution_time_ms"] = int((_time.time() - start) * 1000)
    result["stderr"] = err_buffer.getvalue()

    # Persist globals for the next call. dill handles most objects
    # (dataframes, numpy arrays, fitted sklearn models, dicts/lists);
    # anything that still fails is skipped individually.
    persist = {{}}
    skipped = 0
    try:
        import dill  # type: ignore
        for _k, _v in exec_globals.items():
            if _k.startswith("__"):
                continue
            if _k in ("dill", "sys", "os", "io", "json", "base64", "traceback",
                       "time", "FlushingStream", "real_stdout"):
                continue
            try:
                dill.dumps(_v)
                persist[_k] = _v
            except Exception:
                skipped += 1
        with open(state_file, "wb") as _f:
            dill.dump(persist, _f)
    except Exception:
        # Fallback: keep JSON-serializable globals only.
        persist = {{}}
        for _k, _v in exec_globals.items():
            if _k.startswith("__") or _k in ("sys", "os", "io", "json", "base64",
                                               "traceback", "time", "FlushingStream",
                                               "real_stdout"):
                continue
            try:
                json.dumps(_v)
                persist[_k] = _v
            except Exception:
                skipped += 1
        try:
            with open(json_state_file, "w") as _f:
                json.dump(persist, _f)
        except Exception:
            pass
    result["persisted_count"] = len(persist)

except Exception as e:
    result["error"] = traceback.format_exc()
    result["stderr"] = err_buffer.getvalue()

# Collect matplotlib-generated images saved into the session image dir.
image_dir = os.path.join({ws!r}, ".session_images")
try:
    os.makedirs(image_dir, exist_ok=True)
    for _fname in os.listdir(image_dir):
        _fpath = os.path.join(image_dir, _fname)
        try:
            with open(_fpath, "rb") as _img:
                _b64 = base64.b64encode(_img.read()).decode("ascii")
                _mime = "image/png" if _fname.endswith(".png") else "image/jpeg"
                result["images"].append("data:" + _mime + ";base64," + _b64)
        except Exception:
            pass
    # Clear the image dir so a later call doesn't re-emit old images.
    for _fname in os.listdir(image_dir):
        try:
            os.remove(os.path.join(image_dir, _fname))
        except Exception:
            pass
except Exception:
    pass

real_stdout.write("\\n" + TOKEN + json.dumps(result) + TOKEN + "\\n")
real_stdout.flush()
'''


def _stream_reader(pipe, tag: str, out_q: "queue.Queue[tuple[str, str]]"):
    """Read lines from one pipe and push (tag, line) to the queue. Pushes a
    single (tag, "") sentinel on EOF so the consumer knows that stream closed."""
    if pipe is None:
        out_q.put((tag, ""))
        return
    try:
        for line in pipe:
            out_q.put((tag, line))
    except Exception:
        pass
    out_q.put((tag, ""))  # EOF sentinel for this stream


def run_python(
    code: str,
    session_id: str,
    timeout: int,
    workspace_root: Path,
    on_chunk: Optional[Callable[[str, str], None]] = None,
) -> dict[str, Any]:
    """Execute Python code with persistent session state.

    If ``on_chunk`` is provided, it is called in real time as
    ``on_chunk(stream, text)`` for every stdout/stderr line (stream is
    ``"stdout"`` or ``"stderr"``), enabling streaming output to the UI.
    """
    session_workspace = ensure_session_dirs(session_id, workspace_root)
    # Clear the per-call image dir so we only collect images this run produced.
    image_dir = session_workspace / ".session_images"
    image_dir.mkdir(parents=True, exist_ok=True)
    for f in image_dir.iterdir():
        try:
            f.unlink()
        except Exception:
            pass

    wrapper = _build_wrapper(code, session_workspace)
    env = os.environ.copy()
    # Headless matplotlib backend — avoids Tcl/Tk init errors in a container.
    env["MPLBACKEND"] = env.get("MPLBACKEND") or "Agg"
    cmd = [sys.executable, "-u", "-c", wrapper]

    timeout = min(timeout, MAX_EXECUTION_TIME)
    deadline = time.time() + timeout

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
            start_new_session=True,  # own process group → killpg works
        )
    except Exception as e:
        return {
            "stdout": "",
            "stderr": "",
            "images": [],
            "error": f"Failed to start python: {e}",
            "execution_time_ms": 0,
        }

    out_q: "queue.Queue[tuple[str, str]]" = queue.Queue()
    # One reader per stream avoids the classic stdout/stderr pipe-buffer
    # deadlock (reading one stream while the other fills its OS buffer).
    t_out = threading.Thread(target=_stream_reader, args=(proc.stdout, "out", out_q), daemon=True)
    t_err = threading.Thread(target=_stream_reader, args=(proc.stderr, "err", out_q), daemon=True)
    t_out.start()
    t_err.start()
    eof_seen = {"out": False, "err": False}

    stdout_buf: list[str] = []
    stderr_buf: list[str] = []
    result: dict[str, Any] | None = None
    timed_out = False

    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            timed_out = True
            break
        try:
            stream, line = out_q.get(timeout=remaining)
        except queue.Empty:
            timed_out = True
            break
        # Per-stream EOF sentinel (empty string). Break only when BOTH streams
        # have closed and we still haven't seen a result record.
        if line == "":
            eof_seen[stream] = True
            if all(eof_seen.values()):
                break
            continue

        # The wrapper writes the result as:  TOKEN + json + TOKEN  on its own
        # final line. Detect it here.
        if stream == "out" and _RESULT_TOKEN in line:
            inner = line[line.index(_RESULT_TOKEN) + len(_RESULT_TOKEN):]
            if _RESULT_TOKEN in inner:
                inner = inner[: inner.index(_RESULT_TOKEN)]
            try:
                result = json.loads(inner.strip())
            except Exception:
                result = None
            # Any text before the token on this line is normal stdout.
            before = line[: line.index(_RESULT_TOKEN)]
            if before:
                stdout_buf.append(before)
                if on_chunk:
                    on_chunk("stdout", before)
            break

        if stream == "out":
            stdout_buf.append(line)
            if on_chunk:
                on_chunk("stdout", line)
        else:
            stderr_buf.append(line)
            if on_chunk:
                on_chunk("stderr", line)

    if timed_out:
        # Leak-proof kill: take down the entire process group so child
        # processes the user's code spawned (multiprocessing workers,
        # subprocesses, C threads) don't survive.
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
        t_out.join(timeout=2)
        t_err.join(timeout=2)
        stdout_text = "".join(stdout_buf)
        stderr_text = "".join(stderr_buf)
        return {
            "stdout": stdout_text[-MAX_OUTPUT_SIZE:],
            "stderr": stderr_text[-MAX_OUTPUT_SIZE:],
            "images": [],
            "error": f"Execution timed out after {timeout}s",
            "execution_time_ms": int(timeout * 1000),
        }

    # Drain any remaining output quickly.
    proc.wait(timeout=10)
    # Flush queue
    while True:
        try:
            stream, line = out_q.get_nowait()
        except queue.Empty:
            break
        if line == "":
            eof_seen[stream] = True
            continue
        if stream == "out":
            stdout_buf.append(line)
            if on_chunk:
                on_chunk("stdout", line)
        else:
            stderr_buf.append(line)
            if on_chunk:
                on_chunk("stderr", line)
    t_out.join(timeout=2)
    t_err.join(timeout=2)

    stdout_text = "".join(stdout_buf)
    stderr_text = "".join(stderr_buf)

    if result is None:
        # No sentinel seen — likely a crash in the wrapper itself. Surface
        # whatever we captured.
        return {
            "stdout": stdout_text[-MAX_OUTPUT_SIZE:],
            "stderr": stderr_text[-MAX_OUTPUT_SIZE:],
            "images": [],
            "error": None,
            "execution_time_ms": 0,
        }

    # Ensure stdout/stderr captured buffer is reflected (in case we missed
    # chunked tail), but the wrapper's own result.stdout/stderr are the
    # authoritative.
    if not result.get("stdout"):
        result["stdout"] = stdout_text
    if proc.returncode and proc.returncode != 0 and not result.get("error"):
        result["error"] = f"Subprocess exited with code {proc.returncode}"
    result["stdout"] = result.get("stdout", "")[-MAX_OUTPUT_SIZE:]
    result["stderr"] = (result.get("stderr", "") or stderr_text)[-MAX_OUTPUT_SIZE:]
    return result


__all__ = ["run_python", "ensure_session_dirs", "MAX_OUTPUT_SIZE"]
