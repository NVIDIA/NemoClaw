// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createOldBaseBuildContext } from "../live/rebuild-openclaw.test.ts";

const copiedContexts: string[] = [];

describe("rebuild-openclaw old-base build context", () => {
  afterEach(() => {
    for (const contextPath of copiedContexts.splice(0)) {
      fs.rmSync(contextPath, { recursive: true, force: true });
    }
  });

  it("stages the Dockerfile.base rlimit helper dependency", () => {
    const buildContext = createOldBaseBuildContext();
    copiedContexts.push(buildContext);

    expect(fs.existsSync(path.join(buildContext, "scripts/lib/sandbox-rlimits.sh"))).toBe(true);
  });
});
