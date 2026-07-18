// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { readYaml, type WorkflowJob } from "./helpers/e2e-workflow-contract";

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...parameters: string[]
) => (...args: unknown[]) => Promise<unknown>;

type ReleaseLatestWorkflow = {
  jobs: Record<string, WorkflowJob>;
};

const WORKFLOW_PATH = ".github/workflows/release-latest-tag.yaml";
const RELEASE_TAG = "v0.0.86";
const TAG_OBJECT_SHA = "a".repeat(40);
const RELEASE_COMMIT = "b".repeat(40);
const workflow = readYaml<ReleaseLatestWorkflow>(WORKFLOW_PATH);
const job = workflow.jobs["update-latest"];
const verifyStep = job.steps?.find((step) => step.id === "verify-release-tag");
const moveStep = job.steps?.find(
  (step) => step.name === "Move latest to the verified release tag object",
);
const verifyScript = verifyStep?.with?.script;

function createHarness(verification: { verified: boolean; reason: string }) {
  const getRef = vi.fn().mockResolvedValue({
    data: { object: { sha: TAG_OBJECT_SHA, type: "tag" } },
  });
  const getTag = vi.fn().mockResolvedValue({
    data: {
      object: { sha: RELEASE_COMMIT, type: "commit" },
      tag: RELEASE_TAG,
      verification,
    },
  });
  const setOutput = vi.fn();
  const info = vi.fn();

  return {
    core: { info, setOutput },
    getRef,
    getTag,
    github: { rest: { git: { getRef, getTag } } },
    context: { repo: { owner: "NVIDIA", repo: "NemoClaw" } },
    info,
    setOutput,
  };
}

async function runVerify(harness: ReturnType<typeof createHarness>): Promise<void> {
  expect(verifyScript).toEqual(expect.any(String));
  await new AsyncFunction("github", "context", "core", verifyScript as string)(
    harness.github,
    harness.context,
    harness.core,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("release latest tag workflow", () => {
  // source-shape-contract: security -- Exact verified-object output wiring prevents latest promotion from bypassing GitHub signature verification
  it("binds latest promotion to the exact GitHub-verified tag object", () => {
    expect(verifyStep?.uses).toBe("actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3");
    expect(moveStep?.env?.EXPECTED_RELEASE_TAG_OBJECT).toBe(
      "${{ steps.verify-release-tag.outputs.tag_object_sha }}",
    );
  });

  it("accepts a GitHub-verified signed tag and emits its exact object SHA", async () => {
    vi.stubEnv("RELEASE_TAG", RELEASE_TAG);
    const harness = createHarness({ verified: true, reason: "valid" });

    await runVerify(harness);

    expect(harness.getRef).toHaveBeenCalledWith({
      owner: "NVIDIA",
      ref: `tags/${RELEASE_TAG}`,
      repo: "NemoClaw",
    });
    expect(harness.getTag).toHaveBeenCalledWith({
      owner: "NVIDIA",
      repo: "NemoClaw",
      tag_sha: TAG_OBJECT_SHA,
    });
    expect(harness.setOutput).toHaveBeenCalledWith("tag_object_sha", TAG_OBJECT_SHA);
  });

  it("waits for GitHub signature verification to propagate", async () => {
    vi.useFakeTimers();
    vi.stubEnv("RELEASE_TAG", RELEASE_TAG);
    const harness = createHarness({ verified: true, reason: "valid" });
    harness.getTag
      .mockResolvedValueOnce({
        data: {
          object: { sha: RELEASE_COMMIT, type: "commit" },
          tag: RELEASE_TAG,
          verification: { verified: false, reason: "unsigned" },
        },
      })
      .mockResolvedValue({
        data: {
          object: { sha: RELEASE_COMMIT, type: "commit" },
          tag: RELEASE_TAG,
          verification: { verified: true, reason: "valid" },
        },
      });

    const verification = runVerify(harness);
    await vi.runAllTimersAsync();
    await verification;

    expect(harness.getTag).toHaveBeenCalledTimes(2);
    expect(harness.setOutput).toHaveBeenCalledWith("tag_object_sha", TAG_OBJECT_SHA);
  });

  it("rejects a tag that GitHub never verifies", async () => {
    vi.useFakeTimers();
    vi.stubEnv("RELEASE_TAG", RELEASE_TAG);
    const harness = createHarness({ verified: false, reason: "unsigned" });

    const verification = expect(runVerify(harness)).rejects.toThrow(
      `Release tag ${RELEASE_TAG} is not GitHub-Verified (unsigned)`,
    );
    await vi.runAllTimersAsync();
    await verification;

    expect(harness.getTag).toHaveBeenCalledTimes(10);
    expect(harness.setOutput).not.toHaveBeenCalled();
  });
});
