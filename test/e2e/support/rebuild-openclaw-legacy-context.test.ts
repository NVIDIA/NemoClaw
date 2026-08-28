// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { REPO_ROOT } from "../fixtures/paths.ts";
import { createLegacyOpenClawSandboxContext } from "../live/rebuild-openclaw-legacy-context.ts";

const copiedContexts: string[] = [];

describe("rebuild-openclaw legacy runtime context", () => {
  afterEach(() => {
    for (const contextPath of copiedContexts.splice(0)) {
      fs.rmSync(contextPath, { recursive: true, force: true });
    }
  });

  it("lowers only the OpenClaw runtime inputs and restores the current trusted recipe", () => {
    const sourceDockerfile = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
    const sourceBlueprint = fs.readFileSync(
      path.join(REPO_ROOT, "nemoclaw-blueprint", "blueprint.yaml"),
      "utf8",
    );
    const sourceBaseImage = sourceDockerfile.match(/^ARG BASE_IMAGE=.*$/gm);
    const legacyContext = createLegacyOpenClawSandboxContext({
      rootDir: REPO_ROOT,
      openClawVersion: "2026.3.11",
    });
    copiedContexts.push(legacyContext.buildCtx);

    const patchedDockerfile = fs.readFileSync(legacyContext.dockerfile, "utf8");
    expect(sourceBaseImage).toHaveLength(1);
    expect(patchedDockerfile.match(/^ARG BASE_IMAGE=.*$/gm)).toEqual(sourceBaseImage);
    expect(patchedDockerfile.match(/^ARG OPENCLAW_VERSION=.*$/gm)).toEqual([
      "ARG OPENCLAW_VERSION=2026.3.11",
    ]);
    expect(patchedDockerfile.match(/^ARG NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=.*$/gm)).toEqual([
      "ARG NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1",
    ]);
    expect(fs.readFileSync(legacyContext.blueprint, "utf8")).toMatch(
      /^\s*min_openclaw_version: "2026\.3\.11"$/m,
    );
    const requiredPaths = ["agents/openclaw", "nemoclaw", "nemoclaw-blueprint", "scripts", "src"];
    expect(
      requiredPaths.every((requiredPath) =>
        fs.existsSync(path.join(legacyContext.buildCtx, requiredPath)),
      ),
    ).toBe(true);

    legacyContext.restoreCurrent();

    expect(fs.readFileSync(legacyContext.dockerfile, "utf8")).toBe(sourceDockerfile);
    expect(fs.readFileSync(legacyContext.blueprint, "utf8")).toBe(sourceBlueprint);
    expect(fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8")).toBe(sourceDockerfile);
    expect(
      fs.readFileSync(path.join(REPO_ROOT, "nemoclaw-blueprint", "blueprint.yaml"), "utf8"),
    ).toBe(sourceBlueprint);
  });
});
