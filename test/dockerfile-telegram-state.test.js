// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf-8");

describe("Dockerfile telegram state layout (#975)", () => {
  it("precreates writable telegram state under .openclaw-data", () => {
    expect(DOCKERFILE.includes("mkdir -p /sandbox/.openclaw-data/telegram")).toBeTruthy();
    expect(DOCKERFILE.includes("chown -R sandbox:sandbox /sandbox/.openclaw-data/telegram")).toBeTruthy();
  });

  it("symlinks .openclaw/telegram into .openclaw-data before locking .openclaw", () => {
    const symlink = DOCKERFILE.indexOf("ln -sfn /sandbox/.openclaw-data/telegram /sandbox/.openclaw/telegram");
    const lockStep = DOCKERFILE.indexOf("chown root:root /sandbox/.openclaw");
    const cleanupBeforeSymlink = DOCKERFILE.indexOf("rm -rf /sandbox/.openclaw/telegram");

    expect(symlink).toBeGreaterThan(-1);
    expect(lockStep).toBeGreaterThan(symlink);
    expect(cleanupBeforeSymlink).toBeGreaterThan(-1);
    expect(cleanupBeforeSymlink).toBeLessThan(symlink);
  });
});
