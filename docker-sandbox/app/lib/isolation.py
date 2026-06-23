"""
Per-session filesystem isolation.

Each agent session maps (deterministically, via SHA-256) to a distinct 32-bit
``alloc`` UID/GID in a private range. A session's workspace directory is owned
by its ``alloc`` uid with mode 0700, so only that uid (and the trusted root
server) can reach it. Code execution for a session runs as its ``alloc`` uid
(full privilege drop in the child), and the server accesses a session's files
by briefly switching its effective uid to that ``alloc`` uid.

Because the server itself is the only component switching uids, this is safe
under gunicorn's ``sync`` worker class (one request per worker at a time).
"""

import hashlib
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

WORKSPACE_ROOT = Path(os.environ.get("SANDBOX_WORKSPACE", "/workspace"))
ALLOC_UID_MIN = 100000  # never collides with 0 (root)


def alloc_ids(session_id: str) -> tuple[int, int]:
    h = hashlib.sha256(("chatinterface-jail:" + session_id).encode()).digest()
    n = int.from_bytes(h[:4], "big") % 2_000_000_000
    uid = ALLOC_UID_MIN + n
    if uid == 0:
        uid += 1
    return uid, uid


def _session_dir(session_id: str) -> Path:
    return WORKSPACE_ROOT / session_id


def session_home(session_id: str) -> Path:
    """A per-session private HOME for external-binary subprocesses.

    Owned by the session's alloc uid (mode 0700) so dropped child processes
    (LibreOffice/dotnet/node/python) can write their caches/profiles without
    touching the shared /tmp. The shared /tmp is a single tmpfs: if the root
    server or a probe ever created /tmp/.cache (root-owned, umask 077 -> mode
    0700), every alloc uid was blocked from it, which caused LibreOffice/dconf
    fatal errors ("unable to create directory '/tmp/.cache/dconf'"). A
    per-session HOME sidesteps that and keeps each session's caches isolated.
    """
    home = _session_dir(session_id) / ".home"
    auid, agid = alloc_ids(session_id)
    home.mkdir(parents=True, exist_ok=True)
    try:
        os.chown(home, auid, agid)
        home.chmod(0o700)
    except OSError:
        pass
    return home


def prepare_session(session_id: str) -> Path:
    """Create a session's dir tree owned by its alloc uid, mode 0700.

    Root-owned root permanence is assumed. This must run as root (chown).
    """
    auid, agid = alloc_ids(session_id)
    session_dir = _session_dir(session_id)
    session_dir.mkdir(parents=True, exist_ok=True)
    for sub in ("upload", "output", "temp"):
        d = session_dir / sub
        d.mkdir(parents=True, exist_ok=True)
        os.chown(d, auid, agid)
        d.chmod(0o700)
    os.chown(session_dir, auid, agid)
    session_dir.chmod(0o700)
    return session_dir


def _fix_tree_ownership(session_id: str) -> None:
    """One-time fix-up for files created before isolation existed."""
    auid, agid = alloc_ids(session_id)
    session_dir = _session_dir(session_id)
    if not session_dir.exists():
        return
    for cur, dirs, files in os.walk(session_dir):
        cur_p = Path(cur)
        try:
            os.chown(cur_p, auid, agid)
            cur_p.chmod(0o700)
        except OSError:
            pass
        for name in files:
            fp = cur_p / name
            try:
                os.chown(fp, auid, agid)
                fp.chmod(0o600)
            except OSError:
                pass


def prepare_session_with_migration(session_id: str) -> Path:
    session_dir = _session_dir(session_id)
    marker = session_dir / ".iso_migrated"
    if not marker.exists():
        _fix_tree_ownership(session_id)
    session_dir = prepare_session(session_id)
    try:
        marker.write_text("1", encoding="utf-8")
        os.chown(marker, *alloc_ids(session_id))
        marker.chmod(0o600)
    except OSError:
        pass
    return session_dir


@contextmanager
def as_session_uid(session_id: str) -> Iterator[None]:
    """Run a block of filesystem operations as the session's alloc uid.

    Files created inside the block are owned by ``alloc`` automatically, so
    user code (which runs as the same ``alloc`` uid) can read/modify them.
    Enclosing callers must not be multi-threaded per process (see module doc).
    """
    auid, agid = alloc_ids(session_id)
    saved_uid = os.geteuid()
    saved_gid = os.getegid()
    os.setegid(agid)
    os.seteuid(auid)
    try:
        yield
    finally:
        os.seteuid(saved_uid)
        os.setegid(saved_gid)


def drop_to_session(session_id: str):
    """preexec_fn target: full, irreversible drop to the session's alloc uid."""
    auid, agid = alloc_ids(session_id)

    def _drop():
        os.setgid(agid)
        try:
            os.setgroups([])
        except PermissionError:
            pass
        os.setuid(auid)
        os.umask(0o077)

    return _drop
