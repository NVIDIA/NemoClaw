// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildRefreshMutableOpenClawConfigHashCommand } from "./rebuild-config-hash-command";

function sha256Hex(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function runRefresh(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-c", buildRefreshMutableOpenClawConfigHashCommand(configDir)], {
    encoding: "utf-8",
    env,
    timeout: 5000,
  });
}

describe.skipIf(process.platform !== "linux")("OpenClaw rebuild config hash refresh", () => {
  it("refreshes .config-hash for the current openclaw.json", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-hash-"));
    const configDir = path.join(tmpDir, ".openclaw");
    const configPath = path.join(configDir, "openclaw.json");
    const hashPath = path.join(configDir, ".config-hash");
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, '{"gateway":{"auth":{"token":"fresh"}}}\n');
      fs.writeFileSync(hashPath, "stale  openclaw.json\n");

      const result = runRefresh(configDir);

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(fs.readFileSync(hashPath, "utf-8")).toBe(`${sha256Hex(configPath)}  openclaw.json\n`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses to refresh through a symlinked config file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-hash-symlink-"));
    const configDir = path.join(tmpDir, ".openclaw");
    const targetPath = path.join(tmpDir, "target-openclaw.json");
    const configPath = path.join(configDir, "openclaw.json");
    const hashPath = path.join(configDir, ".config-hash");
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(targetPath, '{"gateway":{"auth":{"token":"target"}}}\n');
      fs.symlinkSync(targetPath, configPath);
      fs.writeFileSync(hashPath, "stale  openclaw.json\n");

      const result = runRefresh(configDir);

      expect(result.status).toBe(11);
      expect(result.stderr).toContain("refusing symlinked OpenClaw config file");
      expect(fs.readFileSync(hashPath, "utf-8")).toBe("stale  openclaw.json\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    "reports hash command failures instead of masking them (#6245)",
    () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-hash-failure-"));
      const configDir = path.join(tmpDir, ".openclaw");
      const binDir = path.join(tmpDir, "bin");
      const hashCommand = path.join(binDir, "sha256sum");
      try {
        fs.mkdirSync(configDir, { recursive: true });
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(configDir, "openclaw.json"), '{"gateway":{}}\n');
        fs.writeFileSync(hashCommand, "#!/bin/sh\nexit 42\n");
        fs.chmodSync(hashCommand, 0o755);

        const result = runRefresh(configDir, {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        });

        expect(result.status).toBe(14);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
