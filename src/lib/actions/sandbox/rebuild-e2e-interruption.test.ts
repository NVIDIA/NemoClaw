// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { maybePauseForRebuildInterruption } from "./rebuild-e2e-interruption";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("rebuild E2E interruption hook", () => {
  it("is inert outside a Vitest process even when failure-injection variables leak", () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NEMOCLAW_E2E_FAILURE_INJECTION", "1");
    vi.stubEnv("NEMOCLAW_E2E_FORCE_FAIL_AT_STEP", "rebuild_prepared");
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    maybePauseForRebuildInterruption("prepared");

    expect(kill).not.toHaveBeenCalled();
  });

  it("stops only the explicitly selected checkpoint in Vitest", () => {
    vi.stubEnv("VITEST", "true");
    vi.stubEnv("NEMOCLAW_E2E_FAILURE_INJECTION", "1");
    vi.stubEnv("NEMOCLAW_E2E_FORCE_FAIL_AT_STEP", "rebuild_prepared");
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    maybePauseForRebuildInterruption("delete_unjournaled");
    maybePauseForRebuildInterruption("prepared");

    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGSTOP");
  });
});
