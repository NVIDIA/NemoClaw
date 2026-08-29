// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildSandboxConfigSyncScript,
  createNemoClawConfigSync,
  runSandboxConfigSync,
  sandboxConfigSyncArgs,
} from "./config-sync";

const itUnix = process.platform === "win32" ? it.skip : it;

function writeFakeCommand(binDir: string, name: string, stdout: string): void {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\n`, { mode: 0o755 });
}

function runConfigSyncScript(
  script: string,
  homeDir: string,
  fakeUid: string,
  fakeOwnerUid = fakeUid,
): void {
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sync-bin-"));
  try {
    writeFakeCommand(fakeBin, "id", fakeUid);
    writeFakeCommand(fakeBin, "stat", fakeOwnerUid);
    const testScript = script
      .replace(
        'nemoclaw_dir="/sandbox/.nemoclaw"',
        `nemoclaw_dir=${JSON.stringify(path.join(homeDir, ".nemoclaw"))}`,
      )
      .replace(
        "config_dir=/sandbox/.openclaw",
        `config_dir=${JSON.stringify(path.join(homeDir, ".openclaw"))}`,
      );
    const result = spawnSync("bash", ["-c", testScript], {
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
  it("revalidates policy authority immediately before sandbox execution", () => {
    const run = vi.fn();
    const revalidatePolicyRequirements = vi.fn(() => {
      throw new Error("policy authority changed");
    });
    const syncConfig = createNemoClawConfigSync({
      getProviderSelectionConfig: () => ({
        endpointType: "custom",
        endpointUrl: "https://inference.local/v1",
        ncpPartner: null,
        model: "model",
        profile: "inference-local",
        credentialEnv: "OPENAI_API_KEY",
        provider: "provider",
        providerLabel: "Provider",
      }),
      run,
      openshellArgv: (args) => ["openshell", ...args],
    });

    expect(() =>
      syncConfig("spark-box", "provider", "model", revalidatePolicyRequirements),
    ).toThrow("policy authority changed");

    expect(revalidatePolicyRequirements).toHaveBeenCalledExactlyOnceWith(
      "synchronize OpenClaw config in sandbox 'spark-box'",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("uses noninteractive sandbox exec for stdin scripts", () => {
    expect(sandboxConfigSyncArgs("spark-box")).toEqual([
      "sandbox",
      "exec",
      "-n",
      "spark-box",
      "--no-tty",
      "--",
      "bash",
      "-s",
    ]);
  });

  itUnix("writes provider selection and tightens managed config permissions", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sync-home-"));
    try {
      const nemoclawDir = path.join(homeDir, ".nemoclaw");
      const openclawDir = path.join(homeDir, ".openclaw");
      const nestedOpenclawDir = path.join(openclawDir, "nested");
      const openclawConfig = path.join(openclawDir, "openclaw.json");
      const openclawHash = path.join(openclawDir, ".config-hash");
      fs.mkdirSync(nemoclawDir, { mode: 0o755 });
      fs.chmodSync(nemoclawDir, 0o755);
      fs.mkdirSync(nestedOpenclawDir, { recursive: true, mode: 0o755 });
      fs.writeFileSync(openclawConfig, "existing OpenClaw config\n", { mode: 0o644 });
      fs.writeFileSync(openclawHash, "existing hash\n", { mode: 0o644 });
      const selection = {
        endpointType: "custom",
        endpointUrl: "https://inference.local/v1",
        ncpPartner: null,
        model: "nemotron-3-nano:30b",
        profile: "inference-local",
        credentialEnv: "OPENAI_API_KEY",
        provider: "compatible-endpoint",
        providerLabel: "Other OpenAI-compatible endpoint",
      } as const;
      const script = buildSandboxConfigSyncScript(selection);

      runConfigSyncScript(script, homeDir, "1234");

      expect(JSON.parse(fs.readFileSync(path.join(nemoclawDir, "config.json"), "utf8"))).toEqual(
        selection,
      );
      expect(modeBits(nemoclawDir)).toBe(0o700);
      expect(modeBits(path.join(nemoclawDir, "config.json"))).toBe(0o600);
      expect(fs.readFileSync(openclawConfig, "utf8")).toBe("existing OpenClaw config\n");
      expect(fs.readFileSync(openclawHash, "utf8")).toBe("existing hash\n");
      expect(fs.statSync(openclawDir).mode & 0o7777).toBe(0o2770);
      expect(fs.statSync(nestedOpenclawDir).mode & 0o7777).toBe(0o2770);
      expect(modeBits(openclawConfig)).toBe(0o660);
      expect(modeBits(openclawHash)).toBe(0o660);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  itUnix("keeps credential values out of sandbox selection config", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sync-home-"));
    try {
      const selection = {
        endpointType: "custom",
        endpointUrl: "https://inference.local/v1",
        ncpPartner: null,
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        profile: "inference-local",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        provider: "compatible-anthropic-endpoint",
        providerLabel: "Other Anthropic-compatible endpoint",
      } as const;
      const script = buildSandboxConfigSyncScript(selection);

      runConfigSyncScript(script, homeDir, "1234");

      expect(
        JSON.parse(fs.readFileSync(path.join(homeDir, ".nemoclaw", "config.json"), "utf8")),
      ).toEqual(selection);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  itUnix("does not chmod a NemoClaw config dir owned by another user", () => {
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

      runConfigSyncScript(script, homeDir, "1234", "0");
      expect(modeBits(nemoclawDir)).toBe(0o755);
      expect(modeBits(path.join(nemoclawDir, "config.json"))).toBe(0o600);
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  itUnix("passes the generated script directly to the sandbox executor", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sync-home-"));
    const runConnectScript = vi.fn();
    const selection = {
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "model",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      provider: "provider",
      providerLabel: "Provider",
    } as const;
    try {
      runSandboxConfigSync("spark-box", {
        getSelectionConfig: () => selection,
        runConnectScript,
      });

      expect(runConnectScript).toHaveBeenCalledTimes(1);
      const [sandboxName, script] = runConnectScript.mock.calls[0]!;
      expect(sandboxName).toBe("spark-box");
      runConfigSyncScript(script, homeDir, "1234");
      expect(
        JSON.parse(fs.readFileSync(path.join(homeDir, ".nemoclaw", "config.json"), "utf8")),
      ).toMatchObject({ ...selection, onboardedAt: expect.any(String) });
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
