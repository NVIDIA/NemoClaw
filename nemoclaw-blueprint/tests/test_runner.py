# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for orchestrator.runner — the NemoClaw Blueprint Runner."""

import json
import subprocess
from unittest.mock import patch

import pytest

from orchestrator.runner import (
    action_plan,
    action_rollback,
    action_status,
    emit_run_id,
    load_blueprint,
    log,
    openshell_available,
    progress,
    run_cmd,
)

# ---------------------------------------------------------------------------
# Helper output functions
# ---------------------------------------------------------------------------


class TestLog:
    def test_log_prints_message(self, capsys):
        log("hello world")
        assert capsys.readouterr().out == "hello world\n"

    def test_log_empty_string(self, capsys):
        log("")
        assert capsys.readouterr().out == "\n"


class TestProgress:
    def test_progress_format(self, capsys):
        progress(42, "Deploying")
        assert capsys.readouterr().out == "PROGRESS:42:Deploying\n"

    def test_progress_zero(self, capsys):
        progress(0, "Starting")
        assert capsys.readouterr().out == "PROGRESS:0:Starting\n"

    def test_progress_hundred(self, capsys):
        progress(100, "Done")
        assert capsys.readouterr().out == "PROGRESS:100:Done\n"


class TestEmitRunId:
    def test_format_starts_with_nc(self, capsys):
        rid = emit_run_id()
        assert rid.startswith("nc-")
        out = capsys.readouterr().out
        assert out.strip() == f"RUN_ID:{rid}"

    def test_unique_ids(self):
        ids = {emit_run_id() for _ in range(10)}
        assert len(ids) == 10


# ---------------------------------------------------------------------------
# load_blueprint
# ---------------------------------------------------------------------------


class TestLoadBlueprint:
    def test_loads_valid_yaml(self, tmp_path, monkeypatch):
        bp_file = tmp_path / "blueprint.yaml"
        bp_file.write_text("version: '0.1.0'\ncomponents: {}")
        monkeypatch.setenv("NEMOCLAW_BLUEPRINT_PATH", str(tmp_path))
        result = load_blueprint()
        assert result["version"] == "0.1.0"

    def test_missing_blueprint_exits(self, tmp_path, monkeypatch):
        monkeypatch.setenv("NEMOCLAW_BLUEPRINT_PATH", str(tmp_path))
        with pytest.raises(SystemExit) as exc_info:
            load_blueprint()
        assert exc_info.value.code == 1


# ---------------------------------------------------------------------------
# run_cmd
# ---------------------------------------------------------------------------


class TestRunCmd:
    @patch("orchestrator.runner.subprocess.run")
    def test_passes_args_without_shell(self, mock_run):
        mock_run.return_value = subprocess.CompletedProcess([], 0)
        run_cmd(["echo", "hi"])
        mock_run.assert_called_once_with(
            ["echo", "hi"],
            check=True,
            capture_output=False,
            text=True,
        )

    @patch("orchestrator.runner.subprocess.run")
    def test_capture_mode(self, mock_run):
        mock_run.return_value = subprocess.CompletedProcess([], 0, stdout="ok")
        run_cmd(["echo"], capture=True, check=False)
        assert mock_run.call_args.kwargs["capture_output"] is True
        assert mock_run.call_args.kwargs["check"] is False


# ---------------------------------------------------------------------------
# openshell_available
# ---------------------------------------------------------------------------


class TestOpenshellAvailable:
    @patch("orchestrator.runner.shutil.which", return_value="/usr/bin/openshell")
    def test_found(self, _mock):
        assert openshell_available() is True

    @patch("orchestrator.runner.shutil.which", return_value=None)
    def test_not_found(self, _mock):
        assert openshell_available() is False


# ---------------------------------------------------------------------------
# action_plan
# ---------------------------------------------------------------------------


class TestActionPlan:
    @patch("orchestrator.runner.openshell_available", return_value=True)
    def test_valid_default_profile(self, _mock, sample_blueprint, capsys):
        plan = action_plan("default", sample_blueprint)
        assert plan["profile"] == "default"
        assert plan["sandbox"]["name"] == "openclaw"
        assert plan["sandbox"]["image"].endswith("openclaw:latest")
        assert plan["inference"]["provider_type"] == "nvidia"
        assert plan["inference"]["model"] == "nvidia/nemotron-3-super-120b-a12b"
        assert plan["dry_run"] is False
        assert plan["run_id"].startswith("nc-")

    @patch("orchestrator.runner.openshell_available", return_value=True)
    def test_dry_run_flag(self, _mock, sample_blueprint):
        plan = action_plan("default", sample_blueprint, dry_run=True)
        assert plan["dry_run"] is True

    @patch("orchestrator.runner.openshell_available", return_value=True)
    def test_endpoint_override(self, _mock, sample_blueprint):
        plan = action_plan("default", sample_blueprint, endpoint_url="http://custom:8080")
        assert plan["inference"]["endpoint"] == "http://custom:8080"

    @patch("orchestrator.runner.openshell_available", return_value=True)
    def test_invalid_profile_exits(self, _mock, sample_blueprint):
        with pytest.raises(SystemExit) as exc_info:
            action_plan("nonexistent", sample_blueprint)
        assert exc_info.value.code == 1

    @patch("orchestrator.runner.openshell_available", return_value=False)
    def test_missing_openshell_exits(self, _mock, sample_blueprint):
        with pytest.raises(SystemExit) as exc_info:
            action_plan("default", sample_blueprint)
        assert exc_info.value.code == 1

    @patch("orchestrator.runner.openshell_available", return_value=True)
    def test_policy_additions_included(self, _mock, sample_blueprint):
        plan = action_plan("default", sample_blueprint)
        assert "nim_service" in plan["policy_additions"]

    @patch("orchestrator.runner.openshell_available", return_value=True)
    def test_plan_emits_json(self, _mock, sample_blueprint, capsys):
        action_plan("default", sample_blueprint)
        output = capsys.readouterr().out
        # Should contain valid JSON (after PROGRESS/RUN_ID lines)
        lines = output.strip().split("\n")
        json_lines = [line for line in lines if not line.startswith(("PROGRESS:", "RUN_ID:"))]
        parsed = json.loads("\n".join(json_lines))
        assert parsed["profile"] == "default"

    @patch("orchestrator.runner.openshell_available", return_value=True)
    def test_vllm_profile_with_credential(self, _mock, sample_blueprint):
        plan = action_plan("vllm", sample_blueprint)
        assert plan["inference"]["credential_env"] == "OPENAI_API_KEY"
        assert plan["inference"]["provider_type"] == "openai"


# ---------------------------------------------------------------------------
# action_status
# ---------------------------------------------------------------------------


class TestActionStatus:
    def test_no_runs_directory(self, tmp_path, monkeypatch, capsys):
        monkeypatch.setattr("orchestrator.runner.Path.home", lambda: tmp_path)
        with pytest.raises(SystemExit) as exc_info:
            action_status()
        assert exc_info.value.code == 0

    def test_empty_runs_directory(self, tmp_path, monkeypatch, capsys):
        state_dir = tmp_path / ".nemoclaw" / "state" / "runs"
        state_dir.mkdir(parents=True)
        monkeypatch.setattr("orchestrator.runner.Path.home", lambda: tmp_path)
        with pytest.raises(SystemExit) as exc_info:
            action_status()
        assert exc_info.value.code == 0

    def test_specific_run_id(self, tmp_path, monkeypatch, capsys):
        rid = "nc-20260319-120000-abcd1234"
        run_dir = tmp_path / ".nemoclaw" / "state" / "runs" / rid
        run_dir.mkdir(parents=True)
        plan_data = {"run_id": rid, "profile": "default"}
        (run_dir / "plan.json").write_text(json.dumps(plan_data))

        monkeypatch.setattr("orchestrator.runner.Path.home", lambda: tmp_path)
        action_status(rid=rid)
        output = capsys.readouterr().out
        # Filter out RUN_ID protocol lines
        content_lines = [
            line for line in output.strip().split("\n")
            if not line.startswith("RUN_ID:")
        ]
        parsed = json.loads("\n".join(content_lines))
        assert parsed["run_id"] == rid

    def test_most_recent_run(self, tmp_path, monkeypatch, capsys):
        state_dir = tmp_path / ".nemoclaw" / "state" / "runs"

        old_run = state_dir / "nc-20260101-000000-aaaa0000"
        old_run.mkdir(parents=True)
        (old_run / "plan.json").write_text(json.dumps({"run_id": old_run.name}))

        new_run = state_dir / "nc-20260319-120000-bbbb1111"
        new_run.mkdir(parents=True)
        (new_run / "plan.json").write_text(json.dumps({"run_id": new_run.name}))

        monkeypatch.setattr("orchestrator.runner.Path.home", lambda: tmp_path)
        action_status()
        output = capsys.readouterr().out
        content_lines = [
            line for line in output.strip().split("\n")
            if not line.startswith("RUN_ID:")
        ]
        parsed = json.loads("\n".join(content_lines))
        assert parsed["run_id"] == new_run.name

    def test_missing_plan_file(self, tmp_path, monkeypatch, capsys):
        rid = "nc-20260319-120000-cccc2222"
        run_dir = tmp_path / ".nemoclaw" / "state" / "runs" / rid
        run_dir.mkdir(parents=True)

        monkeypatch.setattr("orchestrator.runner.Path.home", lambda: tmp_path)
        action_status(rid=rid)
        output = capsys.readouterr().out
        content_lines = [
            line for line in output.strip().split("\n")
            if not line.startswith("RUN_ID:")
        ]
        parsed = json.loads("\n".join(content_lines))
        assert parsed["status"] == "unknown"


# ---------------------------------------------------------------------------
# action_rollback
# ---------------------------------------------------------------------------


class TestActionRollback:
    def test_missing_run_exits(self, tmp_path, monkeypatch):
        monkeypatch.setattr("orchestrator.runner.Path.home", lambda: tmp_path)
        with pytest.raises(SystemExit) as exc_info:
            action_rollback("nc-nonexistent")
        assert exc_info.value.code == 1

    @patch("orchestrator.runner.run_cmd")
    def test_rollback_stops_and_removes_sandbox(self, mock_run_cmd, tmp_path, monkeypatch):
        rid = "nc-20260319-120000-dddd3333"
        run_dir = tmp_path / ".nemoclaw" / "state" / "runs" / rid
        run_dir.mkdir(parents=True)
        plan_data = {"run_id": rid, "sandbox_name": "my-sandbox"}
        (run_dir / "plan.json").write_text(json.dumps(plan_data))

        monkeypatch.setattr("orchestrator.runner.Path.home", lambda: tmp_path)
        action_rollback(rid)

        # Should call openshell sandbox stop, then remove
        calls = mock_run_cmd.call_args_list
        assert len(calls) == 2
        assert calls[0].args[0] == ["openshell", "sandbox", "stop", "my-sandbox"]
        assert calls[1].args[0] == ["openshell", "sandbox", "remove", "my-sandbox"]

    @patch("orchestrator.runner.run_cmd")
    def test_rollback_marks_rolled_back(self, mock_run_cmd, tmp_path, monkeypatch):
        rid = "nc-20260319-120000-eeee4444"
        run_dir = tmp_path / ".nemoclaw" / "state" / "runs" / rid
        run_dir.mkdir(parents=True)
        (run_dir / "plan.json").write_text(json.dumps({"run_id": rid, "sandbox_name": "openclaw"}))

        monkeypatch.setattr("orchestrator.runner.Path.home", lambda: tmp_path)
        action_rollback(rid)

        rolled_back_file = run_dir / "rolled_back"
        assert rolled_back_file.exists()
        # Content should be an ISO timestamp
        content = rolled_back_file.read_text()
        assert "2026" in content

    @patch("orchestrator.runner.run_cmd")
    def test_rollback_without_plan_still_marks(self, mock_run_cmd, tmp_path, monkeypatch):
        rid = "nc-20260319-120000-ffff5555"
        run_dir = tmp_path / ".nemoclaw" / "state" / "runs" / rid
        run_dir.mkdir(parents=True)
        # No plan.json — sandbox commands are skipped

        monkeypatch.setattr("orchestrator.runner.Path.home", lambda: tmp_path)
        action_rollback(rid)

        mock_run_cmd.assert_not_called()
        assert (run_dir / "rolled_back").exists()
