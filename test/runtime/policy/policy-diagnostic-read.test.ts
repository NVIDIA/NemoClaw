// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const requireForTest = createRequire(import.meta.url);
const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const policies = requireForTest(
  path.join(REPO_ROOT, "src", "lib", "policy", "index.ts"),
) as typeof import("../../../src/lib/policy");
const registry = requireForTest(
  path.join(REPO_ROOT, "src", "lib", "state", "registry.ts"),
) as typeof import("../../../src/lib/state/registry");

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

  it("queries the sandbox's recorded gateway when matching diagnostic presets", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-diagnostic-"));
    const fakeOpenshell = path.join(tmpDir, "openshell");
    const argsFile = path.join(tmpDir, "args.txt");
    fs.writeFileSync(
      fakeOpenshell,
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >>${JSON.stringify(argsFile)}`,
        "printf 'Version: 1\\n---\\nversion: 1\\nnetwork_policies: {}\\n'",
      ].join("\n"),
      { mode: 0o755 },
    );

    vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", fakeOpenshell);
    const sandboxSpy = vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "my-assistant",
      gatewayName: "nemoclaw-9090",
      gatewayPort: 9090,
    });
    try {
      expect(policies.getGatewayPresets("my-assistant")).toEqual([]);
      const calls = fs.readFileSync(argsFile, "utf-8").trim().split("\n");
      expect(calls).toContain("policy get -g nemoclaw-9090 --full my-assistant");
      expect(calls).toContain("policy get -g nemoclaw-9090 --base my-assistant");
    } finally {
      sandboxSpy.mockRestore();
      vi.unstubAllEnvs();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
