# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for migrations.snapshot — snapshot/restore logic."""

import json
import shutil
from pathlib import Path
from unittest.mock import patch

import pytest

from migrations.snapshot import (
    create_snapshot,
    cutover_host,
    list_snapshots,
    restore_into_sandbox,
    rollback_from_snapshot,
)


@pytest.fixture()
def mock_home(tmp_path, monkeypatch):
    """Redirect HOME, OPENCLAW_DIR, NEMOCLAW_DIR, and SNAPSHOTS_DIR to tmp_path."""
    monkeypatch.setattr("migrations.snapshot.HOME", tmp_path)
    monkeypatch.setattr("migrations.snapshot.OPENCLAW_DIR", tmp_path / ".openclaw")
    monkeypatch.setattr("migrations.snapshot.NEMOCLAW_DIR", tmp_path / ".nemoclaw")
    monkeypatch.setattr("migrations.snapshot.SNAPSHOTS_DIR", tmp_path / ".nemoclaw" / "snapshots")
    return tmp_path


def _create_openclaw_dir(home: Path) -> Path:
    """Helper: create a fake ~/.openclaw with some config files."""
    oc_dir = home / ".openclaw"
    oc_dir.mkdir(parents=True, exist_ok=True)
    (oc_dir / "config.yaml").write_text("model: nemotron")
    workspace = oc_dir / "workspace"
    workspace.mkdir()
    (workspace / "SOUL.md").write_text("I am a helpful assistant.")
    return oc_dir


# ---------------------------------------------------------------------------
# create_snapshot
# ---------------------------------------------------------------------------


class TestCreateSnapshot:
    def test_no_openclaw_dir_returns_none(self, mock_home):
        assert create_snapshot() is None

    def test_creates_snapshot_with_manifest(self, mock_home):
        _create_openclaw_dir(mock_home)
        snap_dir = create_snapshot()

        assert snap_dir is not None
        assert (snap_dir / "openclaw").is_dir()
        assert (snap_dir / "snapshot.json").exists()

        manifest = json.loads((snap_dir / "snapshot.json").read_text())
        assert manifest["file_count"] == 2  # config.yaml + SOUL.md
        assert "config.yaml" in manifest["contents"]

    def test_snapshot_preserves_files(self, mock_home):
        _create_openclaw_dir(mock_home)
        snap_dir = create_snapshot()

        assert (snap_dir / "openclaw" / "config.yaml").read_text() == "model: nemotron"
        assert (snap_dir / "openclaw" / "workspace" / "SOUL.md").read_text() == (
            "I am a helpful assistant."
        )

    def test_snapshot_stored_under_nemoclaw(self, mock_home):
        _create_openclaw_dir(mock_home)
        snap_dir = create_snapshot()
        assert ".nemoclaw" in str(snap_dir)
        assert "snapshots" in str(snap_dir)

    @patch("migrations.snapshot.datetime")
    def test_multiple_snapshots_have_different_dirs(self, mock_dt, mock_home):
        _create_openclaw_dir(mock_home)

        # Use distinct timestamps so each snapshot gets its own directory
        mock_dt.now.side_effect = [
            type("FakeDT", (), {"strftime": lambda self, fmt: "20260101T000000Z"})(),
            type("FakeDT", (), {"strftime": lambda self, fmt: "20260101T000001Z"})(),
        ]
        snap1 = create_snapshot()
        snap2 = create_snapshot()

        assert snap1 is not None
        assert snap2 is not None
        assert snap1 != snap2


# ---------------------------------------------------------------------------
# restore_into_sandbox
# ---------------------------------------------------------------------------


class TestRestoreIntoSandbox:
    def test_missing_source_returns_false(self, tmp_path):
        assert restore_into_sandbox(tmp_path, "openclaw") is False

    @patch("migrations.snapshot.subprocess.run")
    def test_successful_restore(self, mock_run, tmp_path):
        source = tmp_path / "openclaw"
        source.mkdir()
        (source / "config.yaml").write_text("model: nemotron")
        mock_run.return_value = type("Result", (), {"returncode": 0})()

        assert restore_into_sandbox(tmp_path, "my-sandbox") is True
        mock_run.assert_called_once()
        call_args = mock_run.call_args.args[0]
        assert call_args[0] == "openshell"
        assert "my-sandbox:/sandbox/.openclaw" in call_args[-1]

    @patch("migrations.snapshot.subprocess.run")
    def test_failed_restore_returns_false(self, mock_run, tmp_path):
        source = tmp_path / "openclaw"
        source.mkdir()
        mock_run.return_value = type("Result", (), {"returncode": 1})()

        assert restore_into_sandbox(tmp_path) is False


# ---------------------------------------------------------------------------
# cutover_host
# ---------------------------------------------------------------------------


class TestCutoverHost:
    def test_no_openclaw_returns_true(self, mock_home):
        assert cutover_host(mock_home) is True

    def test_archives_existing_config(self, mock_home):
        oc_dir = _create_openclaw_dir(mock_home)
        assert oc_dir.exists()

        result = cutover_host(mock_home)
        assert result is True
        assert not oc_dir.exists()

        # Should have created an archive
        archives = list(mock_home.glob(".openclaw.pre-nemoclaw.*"))
        assert len(archives) == 1
        assert (archives[0] / "config.yaml").exists()


# ---------------------------------------------------------------------------
# rollback_from_snapshot
# ---------------------------------------------------------------------------


class TestRollbackFromSnapshot:
    def test_missing_snapshot_returns_false(self, tmp_path, mock_home):
        assert rollback_from_snapshot(tmp_path) is False

    def test_restores_from_snapshot(self, mock_home):
        oc_dir = _create_openclaw_dir(mock_home)
        snap_dir = create_snapshot()
        assert snap_dir is not None

        # Delete original config
        shutil.rmtree(oc_dir)
        assert not oc_dir.exists()

        result = rollback_from_snapshot(snap_dir)
        assert result is True
        assert oc_dir.exists()
        assert (oc_dir / "config.yaml").read_text() == "model: nemotron"

    def test_archives_current_before_restoring(self, mock_home):
        oc_dir = _create_openclaw_dir(mock_home)
        snap_dir = create_snapshot()
        assert snap_dir is not None

        # Modify current config
        (oc_dir / "config.yaml").write_text("model: modified")

        result = rollback_from_snapshot(snap_dir)
        assert result is True

        # Current config should be restored from snapshot
        assert (oc_dir / "config.yaml").read_text() == "model: nemotron"

        # Modified config should be archived
        archives = list(mock_home.glob(".openclaw.nemoclaw-archived.*"))
        assert len(archives) == 1
        assert (archives[0] / "config.yaml").read_text() == "model: modified"


# ---------------------------------------------------------------------------
# list_snapshots
# ---------------------------------------------------------------------------


class TestListSnapshots:
    def test_no_snapshots_dir(self, mock_home):
        assert list_snapshots() == []

    def test_lists_snapshots_reverse_chronological(self, mock_home):
        snaps_root = mock_home / ".nemoclaw" / "snapshots"
        older = snaps_root / "20260101T000000Z"
        newer = snaps_root / "20260101T000001Z"
        older.mkdir(parents=True)
        newer.mkdir(parents=True)
        (older / "snapshot.json").write_text(
            json.dumps({"timestamp": "20260101T000000Z", "file_count": 1, "contents": []})
        )
        (newer / "snapshot.json").write_text(
            json.dumps({"timestamp": "20260101T000001Z", "file_count": 2, "contents": []})
        )

        snapshots = list_snapshots()
        assert len(snapshots) == 2
        assert [s["timestamp"] for s in snapshots] == ["20260101T000001Z", "20260101T000000Z"]
        for s in snapshots:
            assert "path" in s
            assert "timestamp" in s
            assert "file_count" in s

    def test_ignores_dirs_without_manifest(self, mock_home):
        snap_dir = mock_home / ".nemoclaw" / "snapshots"
        snap_dir.mkdir(parents=True)
        (snap_dir / "orphan-dir").mkdir()

        assert list_snapshots() == []
