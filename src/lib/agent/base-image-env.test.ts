// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getAgentSandboxBaseImageEnvVar } from "./base-image-env";

describe("agent sandbox base-image environment variables", () => {
  it.each([
    ["openclaw", "NEMOCLAW_SANDBOX_BASE_IMAGE_REF"],
    ["hermes", "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF"],
    ["langchain-deepagents-code", "NEMOCLAW_LANGCHAIN_DEEPAGENTS_CODE_SANDBOX_BASE_IMAGE_REF"],
    ["pi", "NEMOCLAW_PI_SANDBOX_BASE_IMAGE_REF"],
    ["nemocua", "NEMOCLAW_CUA_SANDBOX_IMAGE_REF"],
  ])("maps %s to %s", (agentName, expected) => {
    expect(getAgentSandboxBaseImageEnvVar(agentName)).toBe(expected);
  });
});
