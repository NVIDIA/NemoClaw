// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

describe("external component sandbox lifecycle", () => {
  it.each([
    ["resume", { resume: true, recreateSandbox: () => false }],
    ["recreation", { resume: false, recreateSandbox: () => true }],
  ] as const)("rejects component onboarding during sandbox %s (#11340)", async (_case, mode) => {
    const { deps, calls } = createDeps();

    await expect(
      handleSandboxState({
        ...baseOptions(deps),
        ...mode,
        externalComponentRegistered: true,
      }),
    ).rejects.toThrow(
      "External component onboarding requires a new sandbox and cannot resume, reuse, repair, or recreate one.",
    );

    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
  });
});
