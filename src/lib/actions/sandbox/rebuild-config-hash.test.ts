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

function installRootOwnerStat(binDir: string): void {
  const statCommand = path.join(binDir, "stat");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(statCommand, "#!/bin/sh\nprintf '%s\\n' root\n");
  fs.chmodSync(statCommand, 0o755);
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

  it.each([
    {
      title: "rejects a stale hash when the config directory is root-owned (#9530)",
      initialHash: () => `${"0".repeat(64)}  openclaw.json\n`,
      expectedStatus: 15,
      expectedStderr: "root-owned OpenClaw config hash does not match openclaw.json\n",
    },
    {
      title: "accepts a matching hash when the config directory is root-owned (#9530)",
      initialHash: (configPath: string) => `${sha256Hex(configPath)}  openclaw.json\n`,
      expectedStatus: 0,
      expectedStderr: "",
    },
    {
      title: "rejects a valid hash that names another file in a root-owned directory (#9530)",
      initialHash: (configPath: string) => {
        const decoyPath = path.join(path.dirname(configPath), "decoy.json");
        fs.writeFileSync(decoyPath, '{"decoy":true}\n');
        return `${sha256Hex(decoyPath)}  decoy.json\n`;
      },
      expectedStatus: 15,
      expectedStderr: "root-owned OpenClaw config hash does not match openclaw.json\n",
    },
  ])("$title", ({ initialHash, expectedStatus, expectedStderr }) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-root-hash-"));
    const configDir = path.join(tmpDir, ".openclaw");
    const binDir = path.join(tmpDir, "bin");
    const configPath = path.join(configDir, "openclaw.json");
    const hashPath = path.join(configDir, ".config-hash");
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, '{"gateway":{"auth":{"token":"fresh"}}}\n');
      const expectedHash = initialHash(configPath);
      fs.writeFileSync(hashPath, expectedHash);
      installRootOwnerStat(binDir);

      const result = runRefresh(configDir, {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      });

      expect(result.status).toBe(expectedStatus);
      expect(result.stderr).toBe(expectedStderr);
      expect(fs.readFileSync(hashPath, "utf-8")).toBe(expectedHash);
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
