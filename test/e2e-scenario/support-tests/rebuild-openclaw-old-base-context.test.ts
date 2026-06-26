// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const REBUILD_OPENCLAW_TEST = path.join(
  REPO_ROOT,
  "test/e2e-scenario/live/rebuild-openclaw.test.ts",
);
const DOCKERFILE_BASE = path.join(REPO_ROOT, "Dockerfile.base");

describe("rebuild-openclaw old-base build context", () => {
  it("stages every direct Dockerfile.base COPY dependency", () => {
    const testSource = fs.readFileSync(REBUILD_OPENCLAW_TEST, "utf8");
    const dockerfileBase = fs.readFileSync(DOCKERFILE_BASE, "utf8");
    const directCopyPaths = [...dockerfileBase.matchAll(/^COPY\s+([^\s]+)\s+/gm)]
      .map(([, source]) => source)
      .filter((source): source is string => Boolean(source))
      .filter((source) => !source.startsWith("--"));

    expect(directCopyPaths).not.toHaveLength(0);
    for (const relativePath of directCopyPaths) {
      expect(
        testSource,
        `rebuild-openclaw old-base context must include Dockerfile.base COPY source ${relativePath}`,
      ).toContain(`"${relativePath}"`);
    }
  });
});
