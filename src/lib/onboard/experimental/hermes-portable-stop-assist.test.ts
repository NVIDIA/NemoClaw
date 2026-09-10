// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { hermesPortableLifecycleInternals } from "./hermes-portable-lifecycle";

describe("Hermes portable OpenShell 0.0.116 stop assist", () => {
  it("authenticates the managed process before signaling its group", () => {
    const program = hermesPortableLifecycleInternals.openShellV0116StopAssistProgram;

    expect(program).toContain('managed_argv = (b"bash", b"/usr/local/bin/nemoclaw-start")');
    expect(program).toContain("argv == managed_argv and ppid == 1 and pgrp == pid");
    expect(program).toContain("current_ppid == candidate_ppid");
    expect(program).toContain("current_starttime == starttime");
    expect(program).toContain("argv == candidate_argv");
    expect(program).not.toContain('b"/usr/local/bin/nemoclaw-start" in argv');
  });
});
