// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  validateDcodeBaseImageContract,
  validateDcodeBaseImageImports,
} from "../../../tools/e2e/dcode-base-image-contract.mts";

const RUN_ID = 1234;
const RUN_ATTEMPT = 2;
const HEAD_SHA = "a".repeat(40);
const IMAGE = "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base";
const DIGEST = `sha256:${"b".repeat(64)}`;

function contract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const amd64 = `sha256:${"c".repeat(64)}`;
  const arm64 = `sha256:${"d".repeat(64)}`;
  return {
    contractVersion: 1,
    agent: "langchain-deepagents-code",
    image: IMAGE,
    digest: DIGEST,
    reference: `${IMAGE}@${DIGEST}`,
    platforms: ["linux/amd64", "linux/arm64"],
    platformDigests: { "linux/amd64": amd64, "linux/arm64": arm64 },
    platformReferences: {
      "linux/amd64": `${IMAGE}@${amd64}`,
      "linux/arm64": `${IMAGE}@${arm64}`,
    },
    sourceRevision: HEAD_SHA,
    run: { id: RUN_ID, attempt: RUN_ATTEMPT },
    ...overrides,
  };
}

const expected = { runId: RUN_ID, runAttempt: RUN_ATTEMPT, headSha: HEAD_SHA };

describe("Deep Agents Code E2E base contract", () => {
  it("accepts the exact immutable publication contract (#9049)", () => {
    expect(validateDcodeBaseImageContract(contract(), expected).reference).toBe(
      `${IMAGE}@${DIGEST}`,
    );
  });

  it.each([
    ["a mutable reference", { reference: `${IMAGE}:latest` }, /reference must match/u],
    ["the wrong source revision", { sourceRevision: "e".repeat(40) }, /source revision/u],
    [
      "the wrong publication run",
      { run: { id: RUN_ID + 1, attempt: RUN_ATTEMPT } },
      /run does not match/u,
    ],
    ["an extra field", { unexpected: true }, /unexpected fields/u],
  ])("rejects %s (#9049)", (_case, override, message) => {
    expect(() => validateDcodeBaseImageContract(contract(override), expected)).toThrow(message);
  });

  it("proves both imports from the exact digest in a locked-down container (#9049)", () => {
    const runDocker = vi.fn(() => "nemoclaw-dcode-base-imports-ok");
    validateDcodeBaseImageImports(`${IMAGE}@${DIGEST}`, runDocker);

    expect(runDocker).toHaveBeenCalledWith([
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--user",
      "999:999",
      "--entrypoint",
      "/opt/venv/bin/python3",
      `${IMAGE}@${DIGEST}`,
      "-I",
      "-c",
      'import deepagents; import deepagents_code; print("nemoclaw-dcode-base-imports-ok")',
    ]);
  });

  it("rejects missing or noisy import evidence (#9049)", () => {
    expect(() => validateDcodeBaseImageImports(`${IMAGE}@${DIGEST}`, () => "")).toThrow(
      /did not prove both required imports/u,
    );
  });
});
