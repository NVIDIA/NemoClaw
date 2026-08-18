// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendFileSync: vi.fn(),
  execFileSync: vi.fn<(...args: unknown[]) => string>(),
  readFileSync: vi.fn<(...args: unknown[]) => string>(),
}));

vi.mock("node:child_process", () => ({ execFileSync: mocks.execFileSync }));
vi.mock("node:fs", () => ({
  appendFileSync: mocks.appendFileSync,
  readFileSync: mocks.readFileSync,
}));

import {
  main,
  validateDcodeBaseImageContract,
  validateDcodeBaseImageImports,
} from "../../../tools/e2e/dcode-base-image-contract.mts";

const RUN_ID = 1234;
const RUN_ATTEMPT = 2;
const HEAD_SHA = "a".repeat(40);
const IMAGE = "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base";
const DIGEST = `sha256:${"b".repeat(64)}`;
const AMD64_DIGEST = `sha256:${"c".repeat(64)}`;
const ARM64_DIGEST = `sha256:${"d".repeat(64)}`;
const AMD64_REFERENCE = `${IMAGE}@${AMD64_DIGEST}`;

function contract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    agent: "langchain-deepagents-code",
    image: IMAGE,
    digest: DIGEST,
    reference: `${IMAGE}@${DIGEST}`,
    platforms: ["linux/amd64", "linux/arm64"],
    platformDigests: { "linux/amd64": AMD64_DIGEST, "linux/arm64": ARM64_DIGEST },
    platformReferences: {
      "linux/amd64": AMD64_REFERENCE,
      "linux/arm64": `${IMAGE}@${ARM64_DIGEST}`,
    },
    sourceRevision: HEAD_SHA,
    run: { id: RUN_ID, attempt: RUN_ATTEMPT },
    ...overrides,
  };
}

const expected = { runId: RUN_ID, runAttempt: RUN_ATTEMPT, headSha: HEAD_SHA };

describe("Deep Agents Code E2E base contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("hands the published amd64 reference to the amd64 live target (#9386)", () => {
    const value = contract();
    mocks.readFileSync.mockReturnValue(JSON.stringify(value));
    mocks.execFileSync.mockReturnValue("nemoclaw-dcode-base-imports-ok");

    main(["contract.json"], {
      GITHUB_OUTPUT: "/tmp/dcode-github-output",
      PUBLICATION_HEAD_SHA: HEAD_SHA,
      PUBLICATION_RUN_ATTEMPT: String(RUN_ATTEMPT),
      PUBLICATION_RUN_ID: String(RUN_ID),
    });

    expect(mocks.execFileSync.mock.calls[0]?.[1]).toContain(AMD64_REFERENCE);
    expect(mocks.appendFileSync).toHaveBeenCalledWith(
      "/tmp/dcode-github-output",
      `base_ref=${AMD64_REFERENCE}\ncontract=${JSON.stringify(value)}\n`,
      "utf8",
    );
  });
});
