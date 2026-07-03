// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const requireForTest = createRequire(import.meta.url);
const REPO_ROOT = path.join(import.meta.dirname, "..");
const policies = requireForTest(
  path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"),
) as typeof import("../src/lib/policy");

describe("OpenShell policy read boundaries", () => {
  it("uses the base policy for mutation reads", () => {
    const command = policies.buildPolicyGetCommand("my-assistant");
    expect(command[0]).toMatch(/openshell$/);
    expect(command.slice(1)).toEqual(["policy", "get", "--base", "my-assistant"]);
  });

  it("uses the full effective policy for diagnostic reads", () => {
    const command = policies.buildPolicyGetFullCommand("my-assistant");
    expect(command[0]).toMatch(/openshell$/);
    expect(command.slice(1)).toEqual(["policy", "get", "--full", "my-assistant"]);
  });

  it("queries the full effective policy when matching gateway presets", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-diagnostic-"));
    const fakeOpenshell = path.join(tmpDir, "openshell");
    const argsFile = path.join(tmpDir, "args.txt");
    fs.writeFileSync(
      fakeOpenshell,
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >${JSON.stringify(argsFile)}`,
        "printf 'Version: 1\\n---\\nversion: 1\\nnetwork_policies: {}\\n'",
      ].join("\n"),
      { mode: 0o755 },
    );

    vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", fakeOpenshell);
    try {
      expect(policies.getGatewayPresets("my-assistant")).toEqual([]);
      expect(fs.readFileSync(argsFile, "utf-8").trim()).toBe("policy get --full my-assistant");
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
