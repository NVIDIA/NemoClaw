// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sandboxRootChown = /(?:^RUN|\s&&)\s+chown root:root \/sandbox\s*(?:\\|$)/m;
const sandboxRootChmod = /(?:^RUN|\s&&)\s+chmod 755 \/sandbox\s*(?:\\|$)/m;

function readRepoFile(file: string): string {
  return fs.readFileSync(path.join(repoRoot, file), "utf8");
}

describe("sandbox root permissions", () => {
  it("keeps /sandbox root-owned in the base image", () => {
    const dockerfile = readRepoFile("Dockerfile.base");

    expect(dockerfile).not.toMatch(/chown -R sandbox:sandbox \/sandbox\s*(?:\\|$)/);
    expect(dockerfile).toMatch(sandboxRootChown);
    expect(dockerfile).toMatch(sandboxRootChmod);
  });

  it("relocks /sandbox in the production image for stale base images", () => {
    const dockerfile = readRepoFile("Dockerfile");

    expect(dockerfile).toMatch(sandboxRootChown);
    expect(dockerfile).toMatch(sandboxRootChmod);
  });
});
