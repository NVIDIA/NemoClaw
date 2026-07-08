// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isProcessControlEnvName, PROCESS_CONTROL_ENV_NAMES } from "./process-control-env";

describe("credential-handoff process-control environment policy", () => {
  it("blocks every canonical exact environment name (#5048)", () => {
    for (const name of PROCESS_CONTROL_ENV_NAMES) {
      expect(isProcessControlEnvName(name)).toBe(true);
    }
  });

  it.each([
    "BASH_FUNC_ECHO%%",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_TRACE2_EVENT",
    "NPM_CONFIG_REGISTRY",
    "PIP_INDEX_URL",
  ])("blocks the process-control rule for %s (#5048)", (name) => {
    expect(isProcessControlEnvName(name)).toBe(true);
  });

  it.each([
    "HOME",
    "LANG",
    "PUBLIC_ID",
    "SAFE_SETTING",
  ])("allows unrelated environment name %s (#5048)", (name) => {
    expect(isProcessControlEnvName(name)).toBe(false);
  });
});
