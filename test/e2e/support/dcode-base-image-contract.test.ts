// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  DCODE_BASE_IMAGE_ONBOARD_PLATFORM,
  main,
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

  it("proves both imports from the selected platform digest in a locked-down container (#9386)", () => {
    const runDocker = vi.fn(() => "nemoclaw-dcode-base-imports-ok");
    const platformReference = `${IMAGE}@sha256:${"c".repeat(64)}`;
    validateDcodeBaseImageImports(platformReference, runDocker);

    expect(runDocker).toHaveBeenCalledWith([
      "run",
      "--rm",
      "--platform",
      DCODE_BASE_IMAGE_ONBOARD_PLATFORM,
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
      platformReference,
      "-I",
      "-c",
      'import deepagents; import deepagents_code; print("nemoclaw-dcode-base-imports-ok")',
    ]);
  });

  it("emits the selected platform reference while preserving the full contract (#9386)", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-dcode-base-contract-"));
    const contractPath = join(directory, "contract.json");
    const outputPath = join(directory, "github-output");
    const contractValue = contract();
    const platformReference = `${IMAGE}@sha256:${"c".repeat(64)}`;
    const runDocker = vi.fn(() => "nemoclaw-dcode-base-imports-ok");
    try {
      writeFileSync(contractPath, JSON.stringify(contractValue), "utf8");

      main(
        [contractPath],
        {
          GITHUB_OUTPUT: outputPath,
          PUBLICATION_HEAD_SHA: HEAD_SHA,
          PUBLICATION_RUN_ATTEMPT: String(RUN_ATTEMPT),
          PUBLICATION_RUN_ID: String(RUN_ID),
        },
        runDocker,
      );

      const [baseReferenceOutput, contractOutput] = readFileSync(outputPath, "utf8")
        .trim()
        .split("\n");
      expect(baseReferenceOutput).toBe(`base_ref=${platformReference}`);
      expect(JSON.parse(String(contractOutput).slice("contract=".length))).toEqual(contractValue);
      expect(runDocker).toHaveBeenCalledWith(expect.arrayContaining([platformReference]));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects missing or noisy import evidence (#9049)", () => {
    expect(() => validateDcodeBaseImageImports(`${IMAGE}@${DIGEST}`, () => "")).toThrow(
      /did not prove both required imports/u,
    );
  });
});
