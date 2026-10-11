"""Fork: linked sources — personal-docs folders kept in sync with a folder
outside Odysseus (for example an iCloud folder on the host).

The host folder is bind-mounted read-only under SOURCES_DIR (default
/app/sources; see docker-compose.override.yml). A manifest in personal docs,
``linked_sources.json``, says which files to copy where:

    {
      "constellation": {
        "source": "/app/sources/constellation",
        "copy":   {"docs/posts": "posts", "docs/source": "source", "CLAUDE.md": "CLAUDE.md"},
        "skills": {"docs/odysseus/SKILL.md": "constellation/constellation-map/SKILL.md"}
      }
    }

Each key is a folder name under personal docs. ``copy`` maps a path inside
the source to a path inside that folder: folders are mirrored (files removed
at the source are removed here), files are copied. ``skills`` maps a source
file to a path under the skills directory. Everything is confined: sources
must sit under SOURCES_DIR, targets under the personal-docs folder or the
skills directory. The RAG picker's Refresh calls sync() before re-indexing.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
from typing import Dict, Optional

from src.constants import PERSONAL_DIR, SKILLS_DIR

logger = logging.getLogger(__name__)

SOURCES_DIR = os.getenv("ODYSSEUS_SOURCES_DIR", "/app/sources")
MANIFEST_NAME = "linked_sources.json"


def _manifest_path() -> str:
    return os.path.join(PERSONAL_DIR, MANIFEST_NAME)


def load_manifest() -> Dict[str, dict]:
    path = _manifest_path()
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception as e:  # malformed manifest must not break the app
        logger.warning("linked_sources: cannot read %s: %s", path, e)
        return {}


def _inside(path: str, root: str) -> bool:
    path, root = os.path.realpath(path), os.path.realpath(root)
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False


def entry_for(directory: str) -> Optional[tuple]:
    """(name, entry) when ``directory`` is a linked personal-docs folder."""
    real = os.path.realpath(directory)
    for name, entry in load_manifest().items():
        if isinstance(entry, dict) and os.path.realpath(os.path.join(PERSONAL_DIR, name)) == real:
            return name, entry
    return None


def linked_folders() -> Dict[str, str]:
    """name -> target folder path, for every manifest entry whose source is mounted."""
    out = {}
    for name, entry in load_manifest().items():
        src = isinstance(entry, dict) and entry.get("source")
        if src and _inside(src, SOURCES_DIR) and os.path.isdir(src):
            out[name] = os.path.join(PERSONAL_DIR, name)
    return out


def _skip(name: str) -> bool:
    # Hidden files and iCloud placeholders (".name.icloud") are never copied.
    return name.startswith(".") or name.endswith(".icloud")


def _mirror_dir(src: str, dst: str) -> int:
    """Make ``dst`` an exact copy of ``src``; returns files copied."""
    copied = 0
    os.makedirs(dst, exist_ok=True)
    wanted = set()
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if not _skip(d)]
        rel = os.path.relpath(root, src)
        out_dir = dst if rel == "." else os.path.join(dst, rel)
        os.makedirs(out_dir, exist_ok=True)
        wanted.add(os.path.normpath(out_dir))
        for fn in files:
            if _skip(fn):
                continue
            s, d = os.path.join(root, fn), os.path.join(out_dir, fn)
            wanted.add(os.path.normpath(d))
            if not os.path.exists(d) or os.path.getmtime(s) != os.path.getmtime(d) \
                    or os.path.getsize(s) != os.path.getsize(d):
                shutil.copy2(s, d)
                copied += 1
    # Remove files and folders that no longer exist at the source.
    for root, dirs, files in os.walk(dst, topdown=False):
        for fn in files:
            p = os.path.normpath(os.path.join(root, fn))
            if p not in wanted:
                os.remove(p)
        for dn in dirs:
            p = os.path.normpath(os.path.join(root, dn))
            if p not in wanted and not os.listdir(p):
                os.rmdir(p)
    return copied


def sync(directory: str) -> dict:
    """Copy a linked folder's files from its source. Raises ValueError when the
    folder is not linked or a path escapes its root."""
    found = entry_for(directory)
    if not found:
        raise ValueError("Folder is not a linked source")
    name, entry = found
    source = entry.get("source") or ""
    if not (_inside(source, SOURCES_DIR) and os.path.isdir(source)):
        raise ValueError(f"Source for {name} is not mounted under {SOURCES_DIR}")
    target_root = os.path.join(PERSONAL_DIR, name)
    os.makedirs(target_root, exist_ok=True)

    copied, missing = 0, []
    for src_rel, dst_rel in (entry.get("copy") or {}).items():
        s, d = os.path.join(source, src_rel), os.path.join(target_root, dst_rel)
        if not (_inside(s, source) and _inside(d, target_root)):
            raise ValueError(f"Path escapes its root: {src_rel} -> {dst_rel}")
        if os.path.isdir(s):
            copied += _mirror_dir(s, d)
        elif os.path.isfile(s):
            os.makedirs(os.path.dirname(d), exist_ok=True)
            shutil.copy2(s, d)
            copied += 1
        else:
            missing.append(src_rel)

    skills = 0
    for src_rel, dst_rel in (entry.get("skills") or {}).items():
        s, d = os.path.join(source, src_rel), os.path.join(SKILLS_DIR, dst_rel)
        if not (_inside(s, source) and _inside(d, SKILLS_DIR)):
            raise ValueError(f"Skill path escapes its root: {src_rel} -> {dst_rel}")
        if os.path.isfile(s):
            os.makedirs(os.path.dirname(d), exist_ok=True)
            shutil.copy2(s, d)
            skills += 1
        else:
            missing.append(src_rel)

    logger.info("linked_sources: synced %s (%d files, %d skills, missing=%s)", name, copied, skills, missing)
    return {"name": name, "copied": copied, "skills": skills, "missing": missing}
