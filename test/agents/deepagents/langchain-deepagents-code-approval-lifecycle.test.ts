// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupCachedPatchedFixture,
  cleanupPackageFixtures,
  createPatchedPackageFixture,
  writeManagedAutoApproval,
} from "../../helpers/langchain-deepagents-code-patch-fixture";

const progressiveDisclosureHarness = path.join(
  process.cwd(),
  "test",
  "fixtures",
  "deepagents-progressive-disclosure-harness.py",
);

afterEach(cleanupPackageFixtures);
afterAll(cleanupCachedPatchedFixture);

describe("Managed DCode approval lifecycle", () => {
  it("resets approval after clear while preserving native opt-in and resume modes (#12747)", () => {
    const tempDir = createPatchedPackageFixture();
    writeManagedAutoApproval(tempDir, "thread-opt-in\n");
    const validation = `
import asyncio
import importlib.util
import sys

spec = importlib.util.spec_from_file_location(
    "progressive_disclosure_harness",
    ${JSON.stringify(progressiveDisclosureHarness)},
)
assert spec is not None and spec.loader is not None
progressive_disclosure_harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(progressive_disclosure_harness)
progressive_disclosure_harness._install_stubs()

from deepagents_code import _nemoclaw_managed, agent, app, main as dcode_main
from deepagents_code.approval_mode import ApprovalMode
from deepagents_code.tui.widgets.approval import ApprovalMenu

async def validate():
    assert _nemoclaw_managed.managed_auto_approval_mode() == "thread-opt-in"
    assert _nemoclaw_managed.managed_auto_approval_enabled() is True
    original_argv = sys.argv
    sys.argv = ["dcode"]
    assert dcode_main.parse_args().auto_approve is False
    sys.argv = ["dcode", "--auto-approve"]
    assert dcode_main.parse_args().auto_approve is True
    assert dcode_main.parse_args().startup_mode == "auto"
    assert dcode_main.parse_args().approval_mode == "auto"
    sys.argv = original_argv
    assert agent._resolve_ptc_option(
        ["execute"], tools=[], acknowledge_unsafe=True, auto_approve=True
    ) == ["execute"]
    instance = app.DeepAgentsApp()

    await instance._set_approval_mode(ApprovalMode.MANUAL)
    assert await instance._on_auto_approve_enabled() is True
    assert instance._approval_mode is ApprovalMode.AUTO

    await instance._set_approval_mode(ApprovalMode.MANUAL)
    await instance.action_toggle_auto_approve()
    assert instance._approval_mode is ApprovalMode.AUTO
    await instance.action_toggle_auto_approve()
    assert instance._approval_mode is ApprovalMode.MANUAL

    approval = ApprovalMenu()
    assert approval._options[1][0] == "Enable Auto for this thread (a)"
    approval._handle_selection(1)
    assert approval.decisions == [("auto_approve_all", None)]
    assert approval.notifications == []

    for command in ("/clear", "/force-clear", " /CLEAR "):
        for mode in ApprovalMode:
            await instance._set_approval_mode(mode)
            previous_thread = instance._session_state.thread_id
            await instance._handle_command(command)
            assert instance._session_state.thread_id != previous_thread
            assert instance._approval_mode is ApprovalMode.MANUAL
            assert instance._session_state.approval_mode is ApprovalMode.MANUAL
            assert instance._status_bar.approval_mode == "manual"
            assert instance._auto_approve is False

    for failure, changes_thread in (
        ("clear_should_fail_early", False),
        ("clear_should_fail_after_reset", True),
    ):
        await instance._set_approval_mode(ApprovalMode.AUTO)
        previous_thread = instance._session_state.thread_id
        setattr(instance, failure, True)
        try:
            await instance._handle_command("/clear")
        except RuntimeError as error:
            assert "clear failed" in str(error)
        else:
            raise AssertionError("clear failure was suppressed")
        finally:
            setattr(instance, failure, False)
        expected = ApprovalMode.MANUAL if changes_thread else ApprovalMode.AUTO
        assert (instance._session_state.thread_id != previous_thread) == changes_thread
        assert instance._approval_mode is expected
        assert instance._session_state.approval_mode is expected
        assert instance._status_bar.approval_mode == expected.value

    assert await instance._on_auto_approve_enabled() is True
    assert instance._approval_mode is ApprovalMode.AUTO
    await instance._handle_command("/clear")
    assert instance._approval_mode is ApprovalMode.MANUAL

    await instance._set_approval_mode(ApprovalMode.YOLO)
    await instance._resume_thread("thread-2")
    assert instance._session_state.thread_id == "thread-2"
    assert instance._approval_mode is ApprovalMode.YOLO

    await instance._restart_server_for_agent_swap("agent-2")
    assert instance._assistant_id == "agent-2"
    assert instance._approval_mode is ApprovalMode.YOLO

asyncio.run(validate())
print("managed-auto-approval-ok")
`;
    const result = spawnSync("python3", ["-c", validation], {
      env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("managed-auto-approval-ok");
  });
});
