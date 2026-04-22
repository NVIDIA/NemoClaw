// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression test for #2191 — Hermes Dockerfile copied the shared blueprint
// AFTER dropping to USER sandbox, which cannot read /opt/nemoclaw-blueprint/*
// because COPY preserves restrictive source permissions. The build failed at:
//
//   cp: cannot open '/opt/nemoclaw-blueprint/blueprint.yaml' for reading:
//   Permission denied
//
// The copy must happen while still running as root, matching the OpenClaw
// Dockerfile's layout.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const HERMES_DOCKERFILE = path.join(import.meta.dirname, "..", "agents", "hermes", "Dockerfile");

function firstLineMatching(lines: string[], re: RegExp): number {
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

describe("agents/hermes/Dockerfile blueprint copy ordering (#2191)", () => {
  const source = fs.readFileSync(HERMES_DOCKERFILE, "utf-8");
  const lines = source.split("\n");

  it("copies /opt/nemoclaw-blueprint into /sandbox before dropping to USER sandbox", () => {
    const blueprintCp = firstLineMatching(
      lines,
      /cp\s+-r\s+\/opt\/nemoclaw-blueprint\/\*\s+\/sandbox\/\.nemoclaw\/blueprints\//,
    );
    const userSandbox = firstLineMatching(lines, /^USER\s+sandbox\s*$/);

    expect(blueprintCp).toBeGreaterThanOrEqual(0);
    expect(userSandbox).toBeGreaterThanOrEqual(0);
    expect(blueprintCp).toBeLessThan(userSandbox);
  });
});
