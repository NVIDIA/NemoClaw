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

  it("rejects out-of-context direct Dockerfile.base COPY sources before staging", () => {
    const parentRelativeDockerfilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-dockerfile-")),
      "Dockerfile.base",
    );
    const absoluteDockerfilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-dockerfile-")),
      "Dockerfile.base",
    );
    testFiles.push(
      path.dirname(parentRelativeDockerfilePath),
      path.dirname(absoluteDockerfilePath),
    );
    fs.writeFileSync(parentRelativeDockerfilePath, "COPY ../outside /tmp/outside\n", "utf8");
    fs.writeFileSync(absoluteDockerfilePath, "COPY /etc/passwd /tmp/passwd\n", "utf8");

    expect(() => directDockerfileBaseCopySources(parentRelativeDockerfilePath)).toThrow(
      "Unsupported direct Dockerfile.base COPY source",
    );
    expect(() => directDockerfileBaseCopySources(absoluteDockerfilePath)).toThrow(
      "Unsupported direct Dockerfile.base COPY source",
    );
  });

  it("rejects dockerignore-secret direct Dockerfile.base COPY sources before staging", () => {
    const envDockerfilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-dockerfile-")),
      "Dockerfile.base",
    );
    const secretDockerfilePath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-dockerfile-")),
      "Dockerfile.base",
    );
    testFiles.push(path.dirname(envDockerfilePath), path.dirname(secretDockerfilePath));
    fs.writeFileSync(envDockerfilePath, "COPY .env /tmp/env\n", "utf8");
    fs.writeFileSync(secretDockerfilePath, "COPY secrets/token.json /tmp/token\n", "utf8");

    expect(() => directDockerfileBaseCopySources(envDockerfilePath)).toThrow(
      "Unsupported .dockerignore-secret Dockerfile.base COPY source",
    );
    expect(() => directDockerfileBaseCopySources(secretDockerfilePath)).toThrow(
      "Unsupported .dockerignore-secret Dockerfile.base COPY source",
    );
  });
});
