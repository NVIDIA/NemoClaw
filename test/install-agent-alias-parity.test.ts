// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import os from "node:os";

import { describe, expect, it } from "vitest";

import { resolveAgentNameAlias } from "../dist/lib/agent/defs";
import { INSTALLER_PAYLOAD, TEST_SYSTEM_PATH } from "./helpers/installer-sourced-env";

const AVAILABLE_AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"];
const ALIAS_CASES = [
  ["openclaw", "openclaw"],
  ["nemoclaw", "openclaw"],
  ["hermes", "hermes"],
  ["nemohermes", "hermes"],
  ["langchain-deepagents-code", "langchain-deepagents-code"],
  ["nemo-deepagents", "langchain-deepagents-code"],
  ["NEMO_DEEPAGENTS", "langchain-deepagents-code"],
  ["dcode", "langchain-deepagents-code"],
  ["deepagents", "langchain-deepagents-code"],
  ["Deep Agents", "langchain-deepagents-code"],
  ["deepagents-code", "langchain-deepagents-code"],
  ["deepagentscode", "langchain-deepagents-code"],
  ["langchain", "langchain-deepagents-code"],
  ["LANGCHAIN", "langchain-deepagents-code"],
] as const;

function installerCanonicalAgentName(input: string): string {
  const result = spawnSync(
    "bash",
    ["-c", `source "${INSTALLER_PAYLOAD}"; canonical_agent_name "$1"`, "_", input],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
      env: { HOME: os.tmpdir(), PATH: TEST_SYSTEM_PATH },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("agent alias parity", () => {
  it("keeps installer canonical_agent_name aligned with TypeScript alias resolution", () => {
    for (const [input, expected] of ALIAS_CASES) {
      expect(resolveAgentNameAlias(input, AVAILABLE_AGENTS), input).toBe(expected);
      expect(installerCanonicalAgentName(input), input).toBe(expected);
    }
  });
});
