// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { createOpenclawSetup } from "./openclaw-setup";

describe("OpenClaw sandbox setup", () => {
  it("syncs config through noninteractive sandbox exec", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-setup-"));
    const scriptFile = path.join(tempDir, "sync.sh");
    fs.writeFileSync(scriptFile, "set -e\n", { mode: 0o600 });
    const run = vi.fn();
    const cleanupTempDir = vi.fn();
    try {
      const setup = createOpenclawSetup({
        step: vi.fn(),
        agentProductName: () => "OpenClaw",
        getProviderSelectionConfig: () => ({ provider: "vllm-local" }),
        buildSandboxConfigSyncScript: () => "set -e",
        writeSandboxConfigSyncFile: () => scriptFile,
        run,
        openshellArgv: (args) => ["/usr/bin/openshell", ...args],
        cleanupTempDir,
      });

      await setup("spark-box", "model", "provider");

      expect(run).toHaveBeenCalledWith(
        [
          "/usr/bin/openshell",
          "sandbox",
          "exec",
          "-n",
          "spark-box",
          "--no-tty",
          "--",
          "bash",
          "-s",
        ],
        { input: "set -e\n", stdio: ["pipe", "ignore", "inherit"] },
      );
      expect(cleanupTempDir).toHaveBeenCalledWith(scriptFile, "nemoclaw-sync");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("withholds setup success when policy authority changes during config sync (#9833)", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-setup-"));
    const scriptFile = path.join(tempDir, "sync.sh");
    fs.writeFileSync(scriptFile, "set -e\n", { mode: 0o600 });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const setup = createOpenclawSetup({
        step: vi.fn(),
        agentProductName: () => "OpenClaw",
        getProviderSelectionConfig: () => ({ provider: "vllm-local" }),
        buildSandboxConfigSyncScript: () => "set -e",
        writeSandboxConfigSyncFile: () => scriptFile,
        run: vi.fn(),
        openshellArgv: (args) => ["/usr/bin/openshell", ...args],
        cleanupTempDir: vi.fn(),
      });

      await expect(
        setup("spark-box", "model", "provider", () => {
          throw new Error("policy authority changed");
        }),
      ).rejects.toThrow("policy authority changed");

      expect(log.mock.calls.flat().join("\n")).not.toContain("gateway launched");
    } finally {
      log.mockRestore();
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
