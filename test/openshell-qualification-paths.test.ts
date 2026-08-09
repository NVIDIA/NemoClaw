// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyQualification,
  isOpenShellQualificationSensitivePath,
  loadPullRequestFiles,
  type PullRequestReader,
  validatePullRequestFile,
} from "../scripts/checks/openshell-qualification-paths.mts";

const REPOSITORY = "NVIDIA/NemoClaw";

function prFile(filename: string, status = "modified") {
  return { filename, status };
}

describe("OpenShell qualification-sensitive path classification", () => {
  it.each([
    "nemoclaw-blueprint/blueprint.yaml",
    "scripts/install-openshell.sh",
    "agents/hermes/manifest.yaml",
    "agents/langchain-deepagents-code/managed-dcode-runtime.py",
    "src/lib/onboard/docker-driver-gateway-runtime.ts",
    "src/lib/adapters/container-engine.ts",
    "src/lib/adapters/podman/podman-driver.ts",
    "src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.99.json",
    "nemoclaw/src/blueprint/runner.ts",
    ".github/workflows/openshell-0.0.101-pr-gate.yaml",
    ".github/workflows/openshell-0.0.101-qualification.yaml",
    "scripts/checks/openshell-qualification-bootstrap-contract.mts",
    "scripts/checks/openshell-qualification-contract.mts",
    "scripts/checks/openshell-qualification-github.mts",
    "scripts/checks/verify-openshell-qualification-producer-workflow.mts",
    "scripts/checks/verify-openshell-qualification-pr-gate.mts",
    "scripts/release-cut-tag.sh",
  ])("keeps draft staging path %s inside the trusted gate (#8590)", (candidatePath) => {
    expect(isOpenShellQualificationSensitivePath(candidatePath)).toBe(true);
  });

  it.each([
    "docs/index.mdx",
    "nemoclaw/README.md",
    "agents/foo/README.md",
    "scripts/generate-unrelated-report.mjs",
    "src/lib/messaging/README.md",
    "src/lib/security/credential-hash.ts",
  ])("does not require the OpenShell gate for unrelated path %s (#8590)", (candidatePath) => {
    expect(classifyQualification([validatePullRequestFile(prFile(candidatePath))])).toEqual({
      required: false,
      sensitivePaths: [],
    });
  });

  it("classifies both sides of a rename without trusting candidate metadata (#8590)", () => {
    const renamed = validatePullRequestFile({
      filename: "docs/retired.mdx",
      previous_filename: "scripts/install-openshell.sh",
      status: "renamed",
    });

    expect(classifyQualification([renamed])).toEqual({
      required: true,
      sensitivePaths: ["scripts/install-openshell.sh"],
    });
  });

  it.each([
    [{ filename: "a", status: "mystery" }, "unknown status"],
    [{ filename: "a", status: "renamed" }, "previous_filename"],
    [{ filename: "a", previous_filename: "b", status: "modified" }, "unexpectedly"],
    [{ filename: "../escape", status: "modified" }, "canonical"],
    [{ filename: "scripts\\escape.mts", status: "modified" }, "invalid"],
  ])("rejects malformed pull-request file metadata %# (#8590)", (value, message) => {
    expect(() => validatePullRequestFile(value)).toThrow(message);
  });

  it("paginates through the supported pull-request file bound (#8590)", async () => {
    const api: PullRequestReader = {
      getPullRequestFilesPage: async (_repository, _prNumber, page) =>
        page === 1
          ? Array.from({ length: 100 }, (_, index) => prFile(`docs/${index}.md`))
          : [prFile("scripts/install-openshell.sh")],
    };

    const files = await loadPullRequestFiles(api, REPOSITORY, 1);
    expect(files).toHaveLength(101);
    expect(classifyQualification(files)).toEqual({
      required: true,
      sensitivePaths: ["scripts/install-openshell.sh"],
    });
  });

  it("rejects duplicate files and pagination beyond the supported bound (#8590)", async () => {
    const duplicate: PullRequestReader = {
      getPullRequestFilesPage: async () => [prFile("docs/a.md"), prFile("docs/a.md")],
    };
    const unbounded: PullRequestReader = {
      getPullRequestFilesPage: async (_repository, _prNumber, page) =>
        Array.from({ length: 100 }, (_, index) => prFile(`docs/${page}-${index}.md`)),
    };

    await expect(loadPullRequestFiles(duplicate, REPOSITORY, 1)).rejects.toThrow("duplicated");
    await expect(loadPullRequestFiles(unbounded, REPOSITORY, 1)).rejects.toThrow(
      "pagination is incomplete",
    );
  });
});
