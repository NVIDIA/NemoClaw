// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as processRecovery from "./process-recovery";
import {
  refreshMutableOpenClawConfigHashAfterPostRestoreWrites,
  verifyFinalMutableOpenClawConfigHash,
} from "./rebuild-config-hash";
import {
  buildRefreshMutableOpenClawConfigHashCommand,
  buildVerifyMutableOpenClawConfigHashCommand,
} from "./rebuild-config-hash-command";

const runtimeSelection = {
  gatewayName: "recorded-gateway",
  workspace: "default",
  localTlsDir: "/authority/tls",
} as const;

describe("OpenClaw rebuild config hash target selection", () => {
  beforeEach(() => {
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/hostile/tls");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("refreshes the config hash on the selected target instead of the ambient target (#10514)", () => {
    const execute = vi.spyOn(processRecovery, "executeSandboxCommand").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    });

    expect(
      refreshMutableOpenClawConfigHashAfterPostRestoreWrites("alpha", vi.fn(), runtimeSelection),
    ).toBe(true);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      buildRefreshMutableOpenClawConfigHashCommand(),
      { runtimeSelection },
    );
    expect(process.env.OPENSHELL_GATEWAY).toBe("hostile-gateway");
  });

  it("verifies the config hash on the selected target instead of the ambient target (#10514)", () => {
    const execute = vi.spyOn(processRecovery, "executeSandboxCommand").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    });

    expect(verifyFinalMutableOpenClawConfigHash("alpha", vi.fn(), runtimeSelection)).toBe(true);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      buildVerifyMutableOpenClawConfigHashCommand(),
      { runtimeSelection },
    );
    expect(process.env.OPENSHELL_GATEWAY).toBe("hostile-gateway");
  });
});

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

function runVerify(configDir: string): ReturnType<typeof spawnSync> {
  return spawnSync("bash", ["-c", buildVerifyMutableOpenClawConfigHashCommand(configDir)], {
    encoding: "utf-8",
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

  it("verifies the final pair without changing a stale config hash (#9530)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-final-hash-"));
    const configDir = path.join(tmpDir, ".openclaw");
    const configPath = path.join(configDir, "openclaw.json");
    const hashPath = path.join(configDir, ".config-hash");
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, '{"gateway":{"auth":{"token":"fresh"}}}\n');
      fs.writeFileSync(hashPath, "stale  openclaw.json\n");

      const result = runVerify(configDir);

      expect(result.status).toBe(15);
      expect(result.stderr).toBe("OpenClaw config hash does not match openclaw.json\n");
      expect(fs.readFileSync(hashPath, "utf-8")).toBe("stale  openclaw.json\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("accepts a matching final pair without changing the config hash (#9530)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-final-hash-"));
    const configDir = path.join(tmpDir, ".openclaw");
    const configPath = path.join(configDir, "openclaw.json");
    const hashPath = path.join(configDir, ".config-hash");
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, '{"gateway":{"auth":{"token":"fresh"}}}\n');
      const expectedHash = `${sha256Hex(configPath)}  openclaw.json\n`;
      fs.writeFileSync(hashPath, expectedHash);

      const result = runVerify(configDir);

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(fs.readFileSync(hashPath, "utf-8")).toBe(expectedHash);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      title: "rejects a missing final config without changing the config hash (#9530)",
      arrange: (_configDir: string, hashPath: string) => {
        fs.writeFileSync(hashPath, "stale  openclaw.json\n");
      },
      expectedStatus: 17,
      expectedStderr: "OpenClaw config is not a regular file",
      expectedHash: "stale  openclaw.json\n",
    },
    {
      title: "rejects a dangling final config symlink without changing the config hash (#9530)",
      arrange: (configDir: string, hashPath: string) => {
        fs.symlinkSync(
          path.join(configDir, "missing-openclaw.json"),
          path.join(configDir, "openclaw.json"),
        );
        fs.writeFileSync(hashPath, "stale  openclaw.json\n");
      },
      expectedStatus: 11,
      expectedStderr: "refusing symlinked OpenClaw config file",
      expectedHash: "stale  openclaw.json\n",
    },
    {
      title: "rejects a final config directory without changing the config hash (#9530)",
      arrange: (configDir: string, hashPath: string) => {
        fs.mkdirSync(path.join(configDir, "openclaw.json"));
        fs.writeFileSync(hashPath, "stale  openclaw.json\n");
      },
      expectedStatus: 17,
      expectedStderr: "OpenClaw config is not a regular file",
      expectedHash: "stale  openclaw.json\n",
    },
  ])("$title", ({ arrange, expectedStatus, expectedStderr, expectedHash }) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-final-hash-input-"));
    const configDir = path.join(tmpDir, ".openclaw");
    const hashPath = path.join(configDir, ".config-hash");
    try {
      fs.mkdirSync(configDir, { recursive: true });
      arrange(configDir, hashPath);

      const result = runVerify(configDir);

      expect(result.status).toBe(expectedStatus);
      expect(result.stderr).toContain(expectedStderr);
      expect(fs.readFileSync(hashPath, "utf-8")).toBe(expectedHash);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a missing final config hash (#9530)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-final-hash-input-"));
    const configDir = path.join(tmpDir, ".openclaw");
    const configPath = path.join(configDir, "openclaw.json");
    const hashPath = path.join(configDir, ".config-hash");
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(configPath, '{"gateway":{}}\n');

      const result = runVerify(configDir);

      expect(result.status).toBe(18);
      expect(result.stderr).toContain("OpenClaw config hash is not a regular file");
      expect(fs.existsSync(hashPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a missing final config directory (#9530)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-final-hash-input-"));
    const configDir = path.join(tmpDir, ".openclaw");
    try {
      const result = runVerify(configDir);

      expect(result.status).toBe(16);
      expect(result.stderr).toContain("OpenClaw config directory is not a directory");
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

  it("refuses to verify through a symlinked config file without changing the config hash (#9530)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rebuild-final-hash-symlink-"));
    const configDir = path.join(tmpDir, ".openclaw");
    const targetPath = path.join(tmpDir, "target-openclaw.json");
    const configPath = path.join(configDir, "openclaw.json");
    const hashPath = path.join(configDir, ".config-hash");
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(targetPath, '{"gateway":{"auth":{"token":"target"}}}\n');
      fs.symlinkSync(targetPath, configPath);
      fs.writeFileSync(hashPath, "stale  openclaw.json\n");

      const result = runVerify(configDir);

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
