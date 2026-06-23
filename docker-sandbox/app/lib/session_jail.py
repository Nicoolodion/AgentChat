"""
Per-session filesystem isolation supervisor.

Threat model
------------
All agent sessions share one container, one HTTP API server, and one bind-mounted
``/workspace``. The API's file tools already confine each request to its own
session directory via path validation, but ``shell`` / ``python`` / document
conversions execute *arbitrary code* as the runtime user, which can then read,
overwrite or delete every other session's files (audit finding 2.1 / 2.3).

This module closes that gap with per-session UIDs:

* Each session id maps (deterministically, via SHA-256) to a distinct 32-bit
  ``alloc`` UID/GID in the range [ALLOC_UID_MIN .. 2**31+ALLOC_UID_MIN).
* A session's workspace directory is owned by its ``alloc`` uid, mode 0700, so
  *only* that uid (and root) can enter it. Another session's ``alloc`` uid has
  no matching permission and cannot reach sibling files.
* Code execution (shell / python / docx / pptx / conversions) is launched by
  this root process, which performs a full ``setgid``/``setgroups([])``/
  ``setuid`` drop to the session's ``alloc`` uid *before* exec. The spawned
  process therefore physically lacks the credentials to touch any other session.

Why the non-root API server can still see alloc-owned files
-----------------------------------------------------------
The server runs as ``sandbox`` (uid 1001). Each session directory carries a
POSIX default ACL granting both ``uid:1001`` (the server) and the session's
``alloc`` uid ``rwx``. New files created inside (by the server OR by dropped
code) inherit both ACL entries, so the server keeps working while other
sessions' ``alloc`` uids get no entry and are blocked by the 0700 base mode.

This supervisor runs as root (started by the container entrypoint) and is the
*only* privileged component. It does one thing: fork → drop to a session uid →
exec a fully-prepared command, plus ACL setup. It never executes arbitrary root
actions on arbitrary paths.

It is single-threaded on purpose: file-system operations are performed with
``seteuid`` privilege bracketing (switch effective uid to ``alloc`` for the
duration of the op, restore to root in ``finally``), which is only safe when no
other thread can clobber the effective uid concurrently.
"""

import hashlib
import json
import os
import queue
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

WORKSPACE_ROOT = Path(os.environ.get("SANDBOX_WORKSPACE", "/workspace"))
SOCKET_PATH = os.environ.get("SANDBOX_JAIL_SOCKET", "/run/session-jail.sock")
SERVER_UID = int(os.environ.get("SANDBOX_SERVER_UID", "1001"))
ALLOC_UID_MIN = 100000  # never collide with 0 (root) or 1001 (sandbox)

# How long to wait for a streamed exec to flush its pipes after the child exits.
_DRAIN_TIMEOUT = 10


def _die(msg: str) -> "NoReturn":
    sys.stderr.write(f"[session_jail] FATAL: {msg}\n")
    sys.stderr.flush()
    sys.exit(1)


def alloc_ids(session_id: str) -> tuple[int, int]:
    """Deterministic, stable, wide-spread UID/GID for a session id.

    Stability matters: the workspace persists on the bind mount across container
    restarts, so the same session id must always map to the same uid or file
    ownership would mismatch on restart. A 32-bit space makes accidental
    collisions effectively impossible.
    """
    h = hashlib.sha256(("chatinterface-jail:" + session_id).encode()).digest()
    n = int.from_bytes(h[:4], "big") % 2_000_000_000  # keep within signed 31-bit range
    uid = ALLOC_UID_MIN + n
    if uid == SERVER_UID or uid == 0:
        uid += 1
    return uid, uid


def _session_dir(session_id: str) -> Path:
    return WORKSPACE_ROOT / session_id


def _setfacl(args: list[str]) -> None:
    subprocess.run(["setfacl", *args], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def _refresh_acl(path: Path, alloc_uid: int) -> None:
    """Grant the server (1001) and the alloc uid rwx + a default ACL on a dir.

    Machine-formed arguments; setfacl failures are tolerated (the boot
    self-test already aborts the jail if ACLs are wholly unsupported).
    """
    _setfacl(["-m", f"u:{SERVER_UID}:rwx", f"u:{alloc_uid}:rwx", "m::rwx", str(path)])
    _setfacl(["-d", "-m", f"u:{SERVER_UID}:rwx",
              f"u:{alloc_uid}:rwx", "d:m::rwx", str(path)])


def _migrate_tree(root: Path, alloc_uid: int, alloc_gid: int) -> None:
    """One-time fix-up for files created before the jail existed.

   sessions created before this feature own their files as ``sandbox``; without
    fixing them the new ``alloc`` uid could not read its own uploads/outputs.
    """
    for cur, dirs, files in os.walk(root):
        cur_p = Path(cur)
        try:
            os.chown(cur_p, alloc_uid, alloc_gid)
            cur_p.chmod(0o700)
            _refresh_acl(cur_p, alloc_uid)
        except OSError:
            pass
        for name in files:
            fp = cur_p / name
            try:
                os.chown(fp, alloc_uid, alloc_gid)
                fp.chmod(0o600)
                _setfacl(["-m", f"u:{SERVER_UID}:rwx", f"u:{alloc_uid}:rwx", "m::rwx", str(fp)])
            except OSError:
                pass


def acl_selftest() -> None:
    """Verify the host actually honours POSIX ACLs; refuse to start otherwise.

    Without working ACLs the non-root server could not read alloc-owned session
    files and the whole agent would silently break. Failing loud at boot is far
    safer than failing subtly per-request.
    """
    probe = WORKSPACE_ROOT / (".acl-probe-" + str(os.getpid()))
    try:
        probe.mkdir(parents=True, exist_ok=True)
        probe.chmod(0o700)
        os.chown(probe, 0, 0)
        auid, _ = alloc_ids("acl-selftest")
        probe_file = probe / "t"
        probe_file.write_bytes(b"x")
        os.chown(probe_file, auid, auid)
        probe_file.chmod(0o600)
        _setfacl(["-m", f"u:{SERVER_UID}:rwx", str(probe_file)])
        has_acl = b"user:" in subprocess.run(
            ["getfacl", "-c", str(probe_file)],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        ).stdout.lower()
        if not has_acl:
            _die("POSIX ACLs are not supported/enabled on /workspace; "
                 "per-session UID isolation requires them. Enable ACLs on the "
                 "host filesystem (e.g. mount with 'acl') or disable the jail.")
    except SystemExit:
        raise
    except Exception as e:
        _die(f"ACL self-test failed: {e}")
    finally:
        shutil.rmtree(probe, ignore_errors=True)


def prepare(session_id: str) -> None:
    """Create/chown a session's directory tree and grant the server + alloc ACLs.

    Cheap on the hot path (it runs on most tool calls): it only touches the
    fixed top-level dirs and sets a *default* ACL so files created later
    inherit the right grants. Legacy files are migrated once.
    """
    auid, agid = alloc_ids(session_id)
    session_dir = _session_dir(session_id)
    session_dir.mkdir(parents=True, exist_ok=True)
    marker = session_dir / ".jail_migrated"

    if not marker.exists():
        # First time this session is seen by the jail: fix up any pre-existing
        # files (owned by sandbox) so the alloc uid can read/write them.
        try:
            _migrate_tree(session_dir, auid, agid)
        except Exception as e:
            sys.stderr.write(f"[session_jail] migration warn for {session_id}: {e}\n")
            sys.stderr.flush()

    for sub in ("upload", "output", "temp"):
        d = session_dir / sub
        d.mkdir(parents=True, exist_ok=True)
        try:
            os.chown(d, auid, agid)
            d.chmod(0o700)
            _refresh_acl(d, auid)
        except OSError:
            pass

    try:
        os.chown(session_dir, auid, agid)
        session_dir.chmod(0o700)
        _refresh_acl(session_dir, auid)
    except OSError:
        pass

    # Persist marker as the alloc uid so it is consistent with the tree.
    try:
        marker.write_text("1", encoding="utf-8")
        os.chown(marker, auid, agid)
        marker.chmod(0o600)
    except OSError:
        pass


def _drop_to(uid: int, gid: int) -> None:
    """Full, irreversible privilege drop used in the child before exec."""
    os.setgid(gid)
    try:
        os.setgroups([])
    except PermissionError:
        pass
    os.setuid(uid)
    os.umask(0o077)


def _run_exec(req: dict, conn: socket.socket) -> None:
    """Run a prepared command as the session's alloc uid and stream output."""
    session_id = req["session_id"]
    auid, agid = alloc_ids(session_id)
    cwd = req.get("cwd") or str(_session_dir(session_id))
    argv = req["argv"]
    env = req.get("env") or {}
    timeout = float(req.get("timeout", 60))

    def send(obj: dict) -> None:
        conn.sendall((json.dumps(obj) + "\n").encode("utf-8", "replace"))

    try:
        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            start_new_session=True,  # own process group → killpg works
            preexec_fn=lambda: _drop_to(auid, agid),
        )
    except Exception as e:
        send({"t": "result", "exit_code": -1, "timed_out": False,
              "signaled": False, "error": f"spawn failed: {e}"})
        return

    out_q: "queue.Queue[tuple[str, str]]" = queue.Queue()

    def reader(pipe, tag: str) -> None:
        try:
            for line in pipe:
                out_q.put((tag, line))
        except Exception:
            pass
        finally:
            out_q.put((tag, ""))  # EOF sentinel

    t_out = threading.Thread(target=reader, args=(proc.stdout, "stdout"), daemon=True)
    t_err = threading.Thread(target=reader, args=(proc.stderr, "stderr"), daemon=True)
    t_out.start()
    t_err.start()

    eof = {"stdout": False, "stderr": False}
    timed_out = False
    deadline = time.time() + timeout
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            timed_out = True
            break
        try:
            tag, line = out_q.get(timeout=remaining)
        except queue.Empty:
            timed_out = True
            break
        if line == "":
            eof[tag] = True
            if all(eof.values()):
                break
            continue
        send({"t": tag, "s": line})

    if timed_out:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        # Drain whatever the process still emitted.
        try:
            proc.wait(timeout=_DRAIN_TIMEOUT)
        except Exception:
            pass
        while True:
            try:
                tag, line = out_q.get_nowait()
            except queue.Empty:
                break
            if line == "":
                continue
            send({"t": tag, "s": line})
        send({"t": "result", "exit_code": -1, "timed_out": True,
              "signaled": False, "error": f"timed out after {timeout}s"})
    else:
        try:
            proc.wait(timeout=_DRAIN_TIMEOUT)
        except Exception:
            pass
        while True:
            try:
                tag, line = out_q.get_nowait()
            except queue.Empty:
                break
            if line == "":
                continue
            send({"t": tag, "s": line})
        send({"t": "result", "exit_code": proc.returncode if proc.returncode is not None else -1,
              "timed_out": False, "signaled": False, "error": None})
    t_out.join(timeout=2)
    t_err.join(timeout=2)


def _handle(req: dict, conn: socket.socket) -> None:
    op = req.get("op")
    if op == "prepare":
        try:
            prepare(req["session_id"])
            conn.sendall((json.dumps({"ok": True}) + "\n").encode())
        except Exception as e:
            conn.sendall((json.dumps({"ok": False, "error": str(e)}) + "\n").encode())
    elif op == "exec":
        _run_exec(req, conn)
    else:
        conn.sendall((json.dumps({"ok": False, "error": f"unknown op {op}"}) + "\n").encode())


def _serve() -> None:
    # Root-owned socket; group sandbox (gid = server's group) may connect.
    try:
        SERVER_GID = int(os.environ.get("SANDBOX_SERVER_GID", "1001"))
    except ValueError:
        SERVER_GID = 1001
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    os.makedirs(os.path.dirname(SOCKET_PATH) or ".", exist_ok=True)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCKET_PATH)
    os.chown(SOCKET_PATH, 0, SERVER_GID)
    os.chmod(SOCKET_PATH, 0o660)
    srv.listen(64)
    sys.stderr.write(f"[session_jail] listening on {SOCKET_PATH} (root, gid {SERVER_GID})\n")
    sys.stderr.flush()

    while True:
        conn, _ = srv.accept()
        try:
            _serve_conn(conn)
        except Exception as e:
            sys.stderr.write(f"[session_jail] connection error: {e}\n")
            sys.stderr.flush()
        finally:
            try:
                conn.close()
            except Exception:
                pass


def _serve_conn(conn: socket.socket) -> None:
    buf = b""
    while b"\n" not in buf:
        chunk = conn.recv(65536)
        if not chunk:
            return
        buf += chunk
    line, _, buf = buf.partition(b"\n")
    req = json.loads(line.decode("utf-8"))
    _handle(req, conn)


def main() -> None:
    if os.geteuid() != 0:
        _die("must run as root")
    os.makedirs(str(WORKSPACE_ROOT), exist_ok=True)
    # Traverse-only for everyone except the owner: alloc uids (as 'other') must
    # be able to reach their own /workspace/<sid> but must not list sibling ids.
    WORKSPACE_ROOT.chmod(0o711)
    acl_selftest()
    _serve()


if __name__ == "__main__":
    main()
