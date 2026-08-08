// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyQualification,
  type GitHubReader,
  isOpenShellQualificationSensitivePath,
  loadPullRequestFiles,
  validatePullRequestFile,
} from "../scripts/checks/openshell-qualification-paths.mts";

const REPOSITORY = "NVIDIA/NemoClaw";

function prFile(filename: string, status = "modified") {
  return { filename, status };
}

describe("OpenShell qualification-sensitive path detection", () => {
  it("covers selectors, trust inputs, runtime artifacts, manifests, proofs, and gate surfaces", () => {
    for (const candidatePath of [
      "nemoclaw-blueprint/blueprint.yaml",
      "scripts/install-openshell.sh",
      "agents/hermes/manifest.yaml",
      "agents/langchain-deepagents-code/managed-dcode-runtime.py",
      "src/lib/onboard/docker-driver-gateway-runtime.ts",
      "src/lib/adapters/container-engine.ts",
      "src/lib/adapters/podman/podman-driver.ts",
      "src/lib/onboard/runtime-provider/podman.ts",
      "src/lib/actions/sandbox/supervisor-relaunch.ts",
      "src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.99.json",
      "nemoclaw/src/blueprint/runner.ts",
      "src/lib/sandbox/version.ts",
      "src/lib/onboard/openshell-version.ts",
      "src/lib/adapters/sandbox/command-transport.ts",
      ".github/workflows/podman-cpu-proof.yaml",
      ".github/workflows/openshell-0.0.101-pr-gate.yaml",
      ".github/workflows/openshell-0.0.101-qualification.yaml",
      ".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md",
      ".agents/skills/nemoclaw-maintainer-cut-release-tag/scripts/release-e2e-evidence.mts",
      "scripts/checks/openshell-qualification-contract.mts",
      "scripts/checks/openshell-qualification-core.mts",
      "scripts/checks/openshell-qualification-github.mts",
      "scripts/checks/openshell-qualification-io.mts",
      "scripts/checks/openshell-qualification-matrix.mts",
      "scripts/checks/openshell-qualification-paths.mts",
      "scripts/checks/openshell-qualification-schema.mts",
      "scripts/checks/verify-openshell-qualification-pr-gate.mts",
      "scripts/release-cut-tag.sh",
      "scripts/scorecard/read-artifact-zip.mts",
    ]) {
      expect(isOpenShellQualificationSensitivePath(candidatePath), candidatePath).toBe(true);
    }
    expect(isOpenShellQualificationSensitivePath("docs/index.mdx")).toBe(false);
  });

  it.each([
    "nemoclaw/README.md",
    "agents/foo/README.md",
    "scripts/generate-unrelated-report.mjs",
    "src/lib/messaging/README.md",
    "src/lib/onboard/README.md",
    "src/lib/security/credential-hash.ts",
    "src/lib/core/json-types.ts",
    "src/lib/state/paths.ts",
    "src/lib/tool-disclosure.ts",
  ])("does not require exact-head qualification for unrelated path %s", (candidatePath) => {
    expect(classifyQualification([validatePullRequestFile(prFile(candidatePath))])).toEqual({
      required: false,
      sensitivePaths: [],
    });
  });

  it.each([
    ".github/workflows/e2e.yaml",
    ".github/workflows/installer-hash-check.yaml",
    ".github/actions/ci-installer-hash-check/action.yaml",
    ".github/actions/prepare-e2e/action.yaml",
    ".github/actions/restore-e2e-cli-artifact/action.yaml",
    ".github/actions/upload-e2e-artifacts/action.yaml",
    ".github/actions/verify-openshell-e2e-qualification/action.yaml",
    "scripts/check-installer-hash.sh",
    "scripts/checks/extract-installer-pins.mts",
    "scripts/checks/verify-openshell-e2e-qualification.mts",
    "test/openshell-e2e-qualification.test.ts",
  ])("keeps legacy installer and default full-E2E authority outside scope for %s (#8600)", (candidatePath) => {
    expect(classifyQualification([validatePullRequestFile(prFile(candidatePath))])).toEqual({
      required: false,
      sensitivePaths: [],
    });
  });

  it.each([
    "src/lib/adapters/container-engine.ts",
    "src/lib/adapters/podman/podman-driver.ts",
    "src/lib/onboard/experimental/portable-demo-lifecycle.ts",
    "src/lib/onboard/managed-bootstrap/podman-runtime.ts",
    "src/lib/onboard/runtime-provider/podman.ts",
    "test/e2e/live/managed-image-activation-e2e.test.ts",
  ])("keeps OpenShell managed/rootless runtime path %s qualification-required", (candidatePath) => {
    expect(classifyQualification([validatePullRequestFile(prFile(candidatePath))])).toEqual({
      required: true,
      sensitivePaths: [candidatePath],
    });
  });

  it("uses both sides of a rename and keeps specialized proof paths in the qualification boundary", () => {
    const renamed = validatePullRequestFile({
      filename: "docs/retired.mdx",
      previous_filename: "scripts/install-openshell.sh",
      status: "renamed",
    });
    expect(classifyQualification([renamed])).toEqual({
      required: true,
      sensitivePaths: ["scripts/install-openshell.sh"],
    });
    expect(isOpenShellQualificationSensitivePath("agents/hermes/manifest.yaml")).toBe(true);
    expect(
      isOpenShellQualificationSensitivePath(
        "scripts/checks/verify-openshell-qualification-pr-gate.mts",
      ),
    ).toBe(true);
  });

  it.each([
    [{ filename: "a", status: "mystery" }, "unknown status"],
    [{ filename: "a", status: "renamed" }, "previous_filename"],
    [{ filename: "a", previous_filename: "b", status: "modified" }, "unexpectedly"],
    [{ filename: "../escape", status: "modified" }, "canonical"],
  ])("rejects malformed PR file metadata %#", (value, message) => {
    expect(() => validatePullRequestFile(value)).toThrow(message);
  });

  it("paginates PR files and rejects an incomplete full final page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => prFile(`docs/${index}.md`));
    const api: GitHubReader = {
      async getBytes() {
        return Buffer.alloc(0);
      },
      async getJson(apiPath) {
        const page = Number(new URL(`https://api.invalid/${apiPath}`).searchParams.get("page"));
        return page <= 30 ? firstPage.map((_, index) => prFile(`${page}-${index}.md`)) : [];
      },
    };
    await expect(loadPullRequestFiles(api, REPOSITORY, 1)).rejects.toThrow(
      "pagination is incomplete",
    );
  });
});
