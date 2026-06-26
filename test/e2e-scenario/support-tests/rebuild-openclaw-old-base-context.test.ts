// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createOldBaseBuildContext,
  directDockerfileBaseCopySources,
} from "../live/rebuild-openclaw-old-base-context.ts";

const copiedContexts: string[] = [];
const testFiles: string[] = [];

describe("rebuild-openclaw old-base build context", () => {
  afterEach(() => {
    for (const contextPath of copiedContexts.splice(0)) {
      fs.rmSync(contextPath, { recursive: true, force: true });
    }
    for (const filePath of testFiles.splice(0)) {
      fs.rmSync(filePath, { recursive: true, force: true });
    }
  });

  it("stages every direct Dockerfile.base COPY dependency", () => {
    const buildContext = createOldBaseBuildContext();
    copiedContexts.push(buildContext);

    const stagedSources = directDockerfileBaseCopySources().map((source) =>
      path.join(buildContext, ...source.split("/")),
    );

    expect(stagedSources).not.toHaveLength(0);
    expect(stagedSources.every((source) => fs.existsSync(source))).toBe(true);
  });

  it("parses direct Dockerfile.base COPY syntax without silently ignoring variants", () => {
    const dockerfilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-dockerfile-")),
      "Dockerfile.base",
    );
    testFiles.push(path.dirname(dockerfilePath));
    fs.writeFileSync(
      dockerfilePath,
      [
        "FROM base AS build",
        "copy scripts/lib/sandbox-rlimits.sh /tmp/lowercase",
        "COPY\tnemoclaw-blueprint/blueprint.yaml /tmp/tabbed",
        "COPY --from=build /tmp/ignored /tmp/ignored",
      ].join("\n"),
      "utf8",
    );

    expect(directDockerfileBaseCopySources(dockerfilePath)).toEqual([
      "scripts/lib/sandbox-rlimits.sh",
      "nemoclaw-blueprint/blueprint.yaml",
    ]);
  });
});
