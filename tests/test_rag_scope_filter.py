"""Fork: folder scope for RAG retrieval (chat-bar RAG picker)."""
from src.rag_vector import _in_scope


def test_no_scope_matches_everything():
    assert _in_scope({"source": "/app/data/personal_docs/a/b.md"}, None)
    assert _in_scope({"source": "/app/data/personal_docs/a/b.md"}, "")


def test_scope_matches_files_inside_folder_and_subfolders():
    root = "/app/data/personal_docs/notes"
    assert _in_scope({"source": f"{root}/CLAUDE.md"}, root)
    assert _in_scope({"source": f"{root}/posts/12.md"}, root)
    assert _in_scope({"source": f"{root}/posts/12.md"}, root + "/")
    assert _in_scope({"source": f"{root}/posts/12.md"}, f"{root}/posts")


def test_scope_is_segment_aware_and_excludes_siblings():
    root = "/app/data/personal_docs/notes"
    assert not _in_scope({"source": "/app/data/personal_docs/notes-old/x.md"}, root)
    assert not _in_scope({"source": "/app/data/personal_docs/recipes/x.md"}, root)
    assert not _in_scope({"source": f"{root}/source/hub.md"}, f"{root}/posts")


def test_falls_back_to_directory_metadata():
    assert _in_scope({"directory": "/app/data/personal_docs/notes/posts"},
                     "/app/data/personal_docs/notes")
    assert not _in_scope({}, "/app/data/personal_docs/notes")
