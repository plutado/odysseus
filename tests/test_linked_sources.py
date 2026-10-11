"""Fork: linked sources (copy a mounted host folder into personal docs)."""
import json
import os

import pytest

from src import linked_sources as ls


@pytest.fixture
def env(tmp_path, monkeypatch):
    sources, personal, skills = tmp_path / "sources", tmp_path / "personal", tmp_path / "skills"
    for d in (sources, personal, skills):
        d.mkdir()
    monkeypatch.setattr(ls, "SOURCES_DIR", str(sources))
    monkeypatch.setattr(ls, "PERSONAL_DIR", str(personal))
    monkeypatch.setattr(ls, "SKILLS_DIR", str(skills))
    src = sources / "notes"
    (src / "docs" / "posts").mkdir(parents=True)
    (src / "docs" / "posts" / "a.md").write_text("A")
    (src / "docs" / "posts" / ".hidden").write_text("x")
    (src / "README.md").write_text("R")
    (src / "SKILL.md").write_text("S")
    manifest = {"notes": {"source": str(src),
                          "copy": {"docs/posts": "posts", "README.md": "README.md"},
                          "skills": {"SKILL.md": "notes/notes-map/SKILL.md"}}}
    (personal / ls.MANIFEST_NAME).write_text(json.dumps(manifest))
    return src, personal, skills


def test_sync_copies_files_and_skill(env):
    src, personal, skills = env
    out = ls.sync(str(personal / "notes"))
    assert out["copied"] == 2 and out["skills"] == 1 and out["missing"] == []
    assert (personal / "notes" / "posts" / "a.md").read_text() == "A"
    assert not (personal / "notes" / "posts" / ".hidden").exists()
    assert (personal / "notes" / "README.md").read_text() == "R"
    assert (skills / "notes" / "notes-map" / "SKILL.md").read_text() == "S"


def test_sync_mirrors_deletions_and_skips_unchanged(env):
    src, personal, _ = env
    ls.sync(str(personal / "notes"))
    (src / "docs" / "posts" / "a.md").unlink()
    (src / "docs" / "posts" / "b.md").write_text("B")
    out = ls.sync(str(personal / "notes"))
    assert not (personal / "notes" / "posts" / "a.md").exists()
    assert (personal / "notes" / "posts" / "b.md").read_text() == "B"
    assert out["copied"] == 2  # b.md + README.md (single files always copy)


def test_unlinked_folder_and_escapes_are_refused(env):
    src, personal, _ = env
    with pytest.raises(ValueError):
        ls.sync(str(personal / "other"))
    m = json.loads((personal / ls.MANIFEST_NAME).read_text())
    m["notes"]["copy"] = {"../../etc": "x"}
    (personal / ls.MANIFEST_NAME).write_text(json.dumps(m))
    with pytest.raises(ValueError):
        ls.sync(str(personal / "notes"))


def test_source_outside_sources_dir_is_refused(env, tmp_path):
    _, personal, _ = env
    outside = tmp_path / "outside"
    outside.mkdir()
    m = json.loads((personal / ls.MANIFEST_NAME).read_text())
    m["notes"]["source"] = str(outside)
    (personal / ls.MANIFEST_NAME).write_text(json.dumps(m))
    with pytest.raises(ValueError):
        ls.sync(str(personal / "notes"))
    assert ls.linked_folders() == {}
