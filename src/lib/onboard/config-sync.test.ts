// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildSandboxConfigSyncScript, writeSandboxConfigSyncFile } from "./config-sync";

const itUnix = process.platform === "win32" ? it.skip : it;

function writeFakeCommand(binDir: string, name: string, stdout: string): void {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\n`, { mode: 0o755 });
}

function runConfigSyncScript(script: string, homeDir: string, fakeUid: string): void {
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sync-bin-"));
  try {
    writeFakeCommand(fakeBin, "id", fakeUid);
    writeFakeCommand(fakeBin, "stat", fakeUid);
    const result = spawnSync("bash", ["-c", script], {
      cwd: homeDir,
      env: { ...process.env, HOME: homeDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
      encoding: "utf8",
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
}

function modeBits(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

describe("sandbox config sync helpers", () => {
  it("builds a sandbox sync script that records provider selection without rewriting OpenClaw config", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "nemotron-3-nano:30b",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      provider: "compatible-endpoint",
      providerLabel: "Other OpenAI-compatible endpoint",
    });

    expect(script).toMatch(/nemoclaw_dir="\$\{HOME:-\/sandbox\}\/\.nemoclaw"/);
    expect(script).toMatch(/mkdir -p -m 700 "\$nemoclaw_dir"/);
    expect(script).toMatch(/nemoclaw_dir_uid="\$\(stat -c '%u' "\$nemoclaw_dir"/);
    expect(script).toMatch(/current_uid="\$\(id -u/);
    expect(script).toMatch(
      /if \[ -n "\$nemoclaw_dir_uid" \] && \[ "\$nemoclaw_dir_uid" = "\$current_uid" \]; then/,
    );
    expect(script).toMatch(/chmod 700 "\$nemoclaw_dir"/);
    expect(script).toMatch(/cat > "\$nemoclaw_config"/);
    expect(script).toMatch(/chmod 600 "\$nemoclaw_config"/);
    expect(script).not.toMatch(/^chmod 700 ~\/\.nemoclaw$/m);
    expect(script).toContain('"model": "nemotron-3-nano:30b"');
    expect(script).toContain('"credentialEnv": "OPENAI_API_KEY"');
    expect(script).not.toMatch(/cat > ~\/\.openclaw\/openclaw\.json/);
    expect(script).not.toMatch(/openclaw models set/);
    expect(script).toMatch(/config_dir=\/sandbox\/\.openclaw/);
    expect(script).toMatch(/chmod -R g\+rwX,o-rwx "\$config_dir"/);
    expect(script).toMatch(/find "\$config_dir" -type d -exec chmod g\+s \{\} \+/);
    expect(script).toMatch(/chmod 2770 "\$config_dir"/);
    expect(script).toMatch(
      /chmod 660 "\$config_dir\/openclaw\.json" "\$config_dir\/\.config-hash"/,
    );
    expect(script).toMatch(/\[ "\$config_dir_owner" != "root" \]/);
    expect(script).toMatch(/^\s*exit$/m);
  });

  it("keeps Bedrock Runtime adapter credentials out of sandbox selection config", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
      profile: "inference-local",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      provider: "compatible-anthropic-endpoint",
      providerLabel: "Other Anthropic-compatible endpoint",
    });

    expect(script).toContain('"endpointUrl": "https://inference.local/v1"');
    expect(script).toContain('"credentialEnv": "COMPATIBLE_ANTHROPIC_API_KEY"');
    expect(script).not.toContain("NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN");
    expect(script).not.toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(script).not.toContain("adapter-token");
    expect(script).not.toContain("bedrock-bearer");
    expect(script).not.toContain("bedrock-runtime.us-east-1.amazonaws.com");
  });

  itUnix("tightens user-owned NemoClaw config dirs and files", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sync-home-"));
    try {
      const nemoclawDir = path.join(homeDir, ".nemoclaw");
      fs.mkdirSync(nemoclawDir, { mode: 0o755 });
      fs.chmodSync(nemoclawDir, 0o755);
      const script = buildSandboxConfigSyncScript({
        endpointType: "custom",
        endpointUrl: "https://inference.local/v1",
        ncpPartner: null,
        model: "nemotron-3-nano:30b",
        profile: "inference-local",
        credentialEnv: "OPENAI_API_KEY",
        provider: "compatible-endpoint",
        providerLabel: "Other OpenAI-compatible endpoint",
      });

      runConfigSyncScript(script, homeDir, "1234");

      expect(modeBits(nemoclawDir)).toBe(0o700);
      expect(modeBits(path.join(nemoclawDir, "config.json"))).toBe(0o600);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  itUnix("does not chmod a NemoClaw config dir owned by another user", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sync-home-"));
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sync-bin-"));
    try {
      const nemoclawDir = path.join(homeDir, ".nemoclaw");
      fs.mkdirSync(nemoclawDir, { mode: 0o755 });
      fs.chmodSync(nemoclawDir, 0o755);
      writeFakeCommand(fakeBin, "id", "1234");
      writeFakeCommand(fakeBin, "stat", "0");
      const script = buildSandboxConfigSyncScript({
        endpointType: "custom",
        endpointUrl: "https://inference.local/v1",
        ncpPartner: null,
        model: "nemotron-3-nano:30b",
        profile: "inference-local",
        credentialEnv: "OPENAI_API_KEY",
        provider: "compatible-endpoint",
        providerLabel: "Other OpenAI-compatible endpoint",
      });

      const result = spawnSync("bash", ["-c", script], {
        cwd: homeDir,
        env: { ...process.env, HOME: homeDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
        encoding: "utf8",
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(modeBits(nemoclawDir)).toBe(0o755);
      expect(modeBits(path.join(nemoclawDir, "config.json"))).toBe(0o600);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("writes sandbox sync scripts to a mkdtemp-backed temp file", () => {
    const scriptFile = writeSandboxConfigSyncFile("echo test");
    try {
      expect(scriptFile).toMatch(/nemoclaw-sync.*\.sh$/);
      expect(fs.readFileSync(scriptFile, "utf8")).toBe("echo test\n");
      const parentDir = path.dirname(scriptFile);
      expect(parentDir).not.toBe(os.tmpdir());
      expect(parentDir).toContain("nemoclaw-sync");
      if (process.platform !== "win32") {
        const stat = fs.statSync(scriptFile);
        expect(stat.mode & 0o777).toBe(0o600);
      }
    } finally {
      const parentDir = path.dirname(scriptFile);
      if (parentDir !== os.tmpdir() && path.basename(parentDir).startsWith("nemoclaw-sync-")) {
        fs.rmSync(parentDir, { recursive: true, force: true });
      }
    }
  });
});
