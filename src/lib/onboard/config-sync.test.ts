// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { shellQuote } from "../core/shell-quote";
import {
  buildSandboxConfigSyncScript,
  createNemoClawConfigSync,
  runSandboxConfigSync,
} from "./config-sync";

const itUnix = process.platform === "win32" ? it.skip : it;

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

function createConfigSyncHome(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sync-home-"));
  onTestFinished(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return homeDir;
}

function writeFakeCommand(binDir: string, name: string, stdout: string, group = stdout): void {
  const file = path.join(binDir, name);
  fs.writeFileSync(
    file,
    `#!/bin/sh\nif [ "\${1:-}" = "-g" ]; then printf '%s\\n' ${shellQuote(group)}; else printf '%s\\n' ${shellQuote(stdout)}; fi\n`,
    { mode: 0o755 },
  );
}

function runConfigSyncScript(
  script: string,
  homeDir: string,
  fakeUid: string,
  fakeOwnerUid = fakeUid,
  options: { validationStatus?: number; expectedStatus?: number } = {},
) {
  const fakeBin = fs.mkdtempSync(path.join(homeDir, "bin-"));
  const nativeLog = path.join(fakeBin, "native.log");
  writeFakeCommand(fakeBin, "id", fakeUid, String(process.getgid?.() ?? 0));
  writeFakeCommand(fakeBin, "stat", fakeOwnerUid);
  fs.writeFileSync(
    path.join(fakeBin, "openclaw"),
    `#!/bin/sh
printf '%s|%s|%s|%s\\n' "$*" "$OPENCLAW_STATE_DIR" "$OPENCLAW_CONFIG_PATH" "$HOME" >> ${shellQuote(nativeLog)}
case "$*" in
  'config validate') exit ${options.validationStatus ?? 0} ;;
  'setup --baseline') printf '\\n' >> "$OPENCLAW_CONFIG_PATH" ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o755 },
  );
  const testScript = script
    .replace(
      'nemoclaw_dir="/sandbox/.nemoclaw"',
      `nemoclaw_dir=${shellQuote(path.join(homeDir, ".nemoclaw"))}`,
    )
    .replace(
      "config_dir=/sandbox/.openclaw",
      `config_dir=${shellQuote(path.join(homeDir, ".openclaw"))}`,
    )
    .replace("HOME=/sandbox", `HOME=${shellQuote(homeDir)}`)
    .replaceAll("/usr/local/bin/openclaw", shellQuote(path.join(fakeBin, "openclaw")));
  const result = spawnSync("bash", ["-c", testScript], {
    cwd: homeDir,
    env: { ...process.env, HOME: homeDir, PATH: `${fakeBin}:${process.env.PATH || ""}` },
    encoding: "utf8",
  });
  expect(result.status, result.stderr || result.stdout).toBe(options.expectedStatus ?? 0);
  return {
    result,
    nativeCalls: fs.existsSync(nativeLog)
      ? fs.readFileSync(nativeLog, "utf8").trim().split("\n")
      : [],
  };
}

function modeBits(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

describe("sandbox config sync helpers", () => {
  it("revalidates sandbox identity immediately before sandbox execution", async () => {
    const runBuffered = vi.fn();
    const revalidateSandboxIdentity = vi.fn(() => {
      throw new Error("sandbox identity changed");
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
      sandboxCommandExecutor: { runBuffered },
    });

    await expect(
      syncConfig("spark-box", "provider", "model", revalidateSandboxIdentity),
    ).rejects.toThrow("sandbox identity changed");

    expect(revalidateSandboxIdentity).toHaveBeenCalledExactlyOnceWith(
      "synchronize OpenClaw config in sandbox 'spark-box'",
    );
    expect(runBuffered).not.toHaveBeenCalled();
  });

  it("uses noninteractive buffered sandbox exec for stdin scripts", async () => {
    const runBuffered = vi.fn(async () => ({
      outcome: { kind: "completed" as const, exitCode: 0 },
      stdout: "",
      stderr: "",
    }));
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
      sandboxCommandExecutor: { runBuffered },
    });

    await syncConfig("spark-box", "provider", "model");

    expect(runBuffered).toHaveBeenCalledWith({
      sandboxName: "spark-box",
      target: { kind: "selected" },
      command: ["/bin/bash", "-s"],
      tty: false,
      input: expect.stringContaining('"provider": "provider"'),
    });
  });

  it("propagates typed sandbox execution failures", async () => {
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
      sandboxCommandExecutor: {
        runBuffered: async () => ({
          outcome: {
            kind: "failed",
            error: { kind: "timeout", message: "config sync timed out" },
          },
          stdout: "",
          stderr: "",
        }),
      },
    });

    await expect(syncConfig("spark-box", "provider", "model")).rejects.toThrow(
      "config sync timed out",
    );
  });

  itUnix("writes selection and validates native state without changing its modes", () => {
    const homeDir = createConfigSyncHome();
    const nemoclawDir = path.join(homeDir, ".nemoclaw");
    const openclawDir = path.join(homeDir, ".openclaw");
    const nestedOpenclawDir = path.join(openclawDir, "nested");
    const openclawConfig = path.join(openclawDir, "openclaw.json");
    fs.mkdirSync(nemoclawDir, { mode: 0o755 });
    fs.chmodSync(nemoclawDir, 0o755);
    fs.mkdirSync(nestedOpenclawDir, { recursive: true, mode: 0o750 });
    fs.chmodSync(openclawDir, 0o750);
    fs.chmodSync(nestedOpenclawDir, 0o750);
    const existingConfig = {
      gateway: { mode: "local" },
      models: {
        providers: { inference: { baseUrl: "http://inference.local/v1", apiKey: "unused" } },
      },
      agents: { defaults: { skipBootstrap: true } },
    };
    fs.writeFileSync(openclawConfig, JSON.stringify(existingConfig), { mode: 0o640 });
    const script = buildSandboxConfigSyncScript(selection);

    const { nativeCalls } = runConfigSyncScript(script, homeDir, String(process.getuid?.()));

    expect(JSON.parse(fs.readFileSync(path.join(nemoclawDir, "config.json"), "utf8"))).toEqual(
      selection,
    );
    expect(modeBits(nemoclawDir)).toBe(0o700);
    expect(modeBits(path.join(nemoclawDir, "config.json"))).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(openclawConfig, "utf8"))).toEqual(existingConfig);
    expect(nativeCalls).toEqual([`config validate|${openclawDir}|${openclawConfig}|${homeDir}`]);
    expect(modeBits(openclawDir)).toBe(0o750);
    expect(modeBits(nestedOpenclawDir)).toBe(0o750);
    expect(modeBits(openclawConfig)).toBe(0o640);
  });

  itUnix("syncs Hermes selection while preserving an existing OpenClaw directory", async () => {
    const homeDir = createConfigSyncHome();
    const configDir = path.join(homeDir, ".openclaw");
    const configFile = path.join(configDir, "openclaw.json");
    const hashFile = path.join(configDir, ".config-hash");
    fs.mkdirSync(configDir, { mode: 0o750 });
    fs.writeFileSync(configFile, "retained user state\n", { mode: 0o640 });
    fs.writeFileSync(hashFile, "retained hash\n", { mode: 0o640 });
    const modesBefore = [configDir, configFile, hashFile].map(modeBits);
    const runConnectScript = vi.fn(async (_name: string, script: string) => {
      const { nativeCalls } = runConfigSyncScript(script, homeDir, "1234", "1234", {
        validationStatus: 127,
      });
      expect(nativeCalls).toEqual([]);
    });

    await runSandboxConfigSync("hermes-reuse", {
      getSelectionConfig: () => ({ ...selection, agent: "hermes" }),
      runConnectScript,
    });

    expect(runConnectScript).toHaveBeenCalledOnce();
    expect(
      JSON.parse(fs.readFileSync(path.join(homeDir, ".nemoclaw", "config.json"), "utf8")),
    ).toMatchObject({ ...selection, agent: "hermes", onboardedAt: expect.any(String) });
    expect(fs.readFileSync(configFile, "utf8")).toBe("retained user state\n");
    expect(fs.readFileSync(hashFile, "utf8")).toBe("retained hash\n");
    expect([configDir, configFile, hashFile].map(modeBits)).toEqual(modesBefore);
  });

  itUnix("keeps credential values out of sandbox selection config", () => {
    const homeDir = createConfigSyncHome();
    const anthropicSelection = {
      ...selection,
      model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      provider: "compatible-anthropic-endpoint",
      providerLabel: "Other Anthropic-compatible endpoint",
    } as const;
    const script = buildSandboxConfigSyncScript(anthropicSelection);

    runConfigSyncScript(script, homeDir, "1234");

    expect(
      JSON.parse(fs.readFileSync(path.join(homeDir, ".nemoclaw", "config.json"), "utf8")),
    ).toEqual(anthropicSelection);
  });

  itUnix("leaves an invalid native configuration unchanged", () => {
    const homeDir = createConfigSyncHome();
    const configDir = path.join(homeDir, ".openclaw");
    const configFile = path.join(configDir, "openclaw.json");
    const config = "{invalid";
    fs.mkdirSync(configDir);
    fs.writeFileSync(configFile, config);
    const script = buildSandboxConfigSyncScript(selection);
    const { nativeCalls } = runConfigSyncScript(
      script,
      homeDir,
      String(process.getuid?.()),
      undefined,
      { validationStatus: 1, expectedStatus: 1 },
    );
    expect(nativeCalls.map((call) => call.split("|")[0])).toEqual(["config validate"]);
    expect(fs.readFileSync(configFile, "utf8")).toBe(config);
  });

  itUnix("does not chmod a NemoClaw config dir owned by another user", () => {
    const homeDir = createConfigSyncHome();
    const nemoclawDir = path.join(homeDir, ".nemoclaw");
    fs.mkdirSync(nemoclawDir, { mode: 0o755 });
    fs.chmodSync(nemoclawDir, 0o755);
    const script = buildSandboxConfigSyncScript(selection);

    runConfigSyncScript(script, homeDir, "1234", "0");
    expect(modeBits(nemoclawDir)).toBe(0o755);
    expect(modeBits(path.join(nemoclawDir, "config.json"))).toBe(0o600);
  });

  itUnix("passes the generated script directly to the sandbox executor", async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sync-home-"));
    const runConnectScript = vi.fn<(sandboxName: string, scriptContent: string) => Promise<void>>(
      async () => undefined,
    );
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
      await runSandboxConfigSync("spark-box", {
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
