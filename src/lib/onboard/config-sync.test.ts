// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  options: { modes?: number[]; validationStatus?: number; expectedStatus?: number } = {},
) {
  const fakeBin = fs.mkdtempSync(path.join(homeDir, "bin-"));
  const nativeLog = path.join(fakeBin, "native.log");
  const normalizerPath = path.join(fakeBin, "normalizer.py");
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
  fs.writeFileSync(
    normalizerPath,
    [
      "import os, runpy, sys",
      `normalizer = runpy.run_path(${JSON.stringify(path.resolve(import.meta.dirname, "../../../scripts/lib/normalize_mutable_config_perms.py"))})`,
      `root_fd, _ = normalizer["normalize_owner_tree"](sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), modes=(${(options.modes ?? [0o2770, 0o660]).join(", ")}))`,
      "os.close(root_fd)",
    ].join("\n"),
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
    .replaceAll("/usr/local/bin/openclaw", shellQuote(path.join(fakeBin, "openclaw")))
    .replaceAll(
      "/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py",
      shellQuote(normalizerPath),
    );
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

  itUnix.each([
    [0o700, 0o600, 0o755],
    [0o2770, 0o660, 0o2770],
  ])(
    "writes selection and initializes native state with owner-selected modes [case %#]",
    (directoryMode, fileMode, nestedMode) => {
      const homeDir = createConfigSyncHome();
      const nemoclawDir = path.join(homeDir, ".nemoclaw");
      const openclawDir = path.join(homeDir, ".openclaw");
      const nestedOpenclawDir = path.join(openclawDir, "nested");
      const openclawConfig = path.join(openclawDir, "openclaw.json");
      const openclawHash = path.join(openclawDir, ".config-hash");
      fs.mkdirSync(nemoclawDir, { mode: 0o755 });
      fs.chmodSync(nemoclawDir, 0o755);
      fs.mkdirSync(nestedOpenclawDir, { recursive: true, mode: 0o755 });
      const existingConfig = {
        gateway: { mode: "local" },
        models: {
          providers: { inference: { baseUrl: "http://inference.local/v1", apiKey: "unused" } },
        },
        agents: { defaults: { skipBootstrap: true } },
      };
      fs.writeFileSync(openclawConfig, JSON.stringify(existingConfig), { mode: 0o644 });
      fs.writeFileSync(openclawHash, "existing hash\n", { mode: 0o644 });
      const script = buildSandboxConfigSyncScript(selection);

      const { nativeCalls } = runConfigSyncScript(
        script,
        homeDir,
        String(process.getuid?.()),
        undefined,
        { modes: [directoryMode, fileMode] },
      );

      expect(JSON.parse(fs.readFileSync(path.join(nemoclawDir, "config.json"), "utf8"))).toEqual(
        selection,
      );
      expect(modeBits(nemoclawDir)).toBe(0o700);
      expect(modeBits(path.join(nemoclawDir, "config.json"))).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(openclawConfig, "utf8"))).toEqual(existingConfig);
      expect(fs.readFileSync(openclawHash, "utf8")).toBe(
        `${createHash("sha256").update(fs.readFileSync(openclawConfig)).digest("hex")}  openclaw.json\n`,
      );
      expect(nativeCalls).toEqual([
        `config validate|${openclawDir}|${openclawConfig}|${homeDir}`,
        `setup --baseline|${openclawDir}|${openclawConfig}|${homeDir}`,
      ]);
      expect(fs.statSync(openclawDir).mode & 0o7777).toBe(directoryMode);
      expect(fs.statSync(nestedOpenclawDir).mode & 0o7777).toBe(nestedMode);
      expect(modeBits(openclawConfig)).toBe(fileMode);
      expect(modeBits(openclawHash)).toBe(fileMode);
    },
  );

  itUnix("propagates a real config normalizer ownership refusal", () => {
    const homeDir = createConfigSyncHome();
    const configDir = path.join(homeDir, ".openclaw");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "openclaw.json"), '{"gateway":{"mode":"local"}}');
    const script = buildSandboxConfigSyncScript(selection);
    const { result, nativeCalls } = runConfigSyncScript(
      script,
      homeDir,
      String((process.getuid?.() ?? 0) + 1),
      undefined,
      { modes: [0o700, 0o600], expectedStatus: 1 },
    );
    expect(result.stderr).toContain("UnsafeTree");
    expect(nativeCalls.map((call) => call.split("|")[0])).toEqual([
      "config validate",
      "setup --baseline",
    ]);
    expect(fs.statSync(configDir).uid).toBe(process.getuid?.());
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

  const seedHashFile = (hashFile: string, _protectedFile: string) =>
    fs.writeFileSync(hashFile, "original hash\n");
  itUnix.each([
    { kind: "invalid config", seedHash: seedHashFile },
    {
      kind: "hash symlink",
      seedHash: (hashFile: string, protectedFile: string) =>
        fs.symlinkSync(protectedFile, hashFile),
    },
    { kind: "host transaction", seedHash: seedHashFile },
  ])("preserves protected state for $kind", ({ kind, seedHash }) => {
    const homeDir = createConfigSyncHome();
    const configDir = path.join(homeDir, ".openclaw");
    const configFile = path.join(configDir, "openclaw.json");
    const hashFile = path.join(configDir, ".config-hash");
    const protectedFile = path.join(homeDir, "protected");
    const config = kind === "invalid config" ? "{invalid" : '{"gateway":{"mode":"local"}}';
    fs.mkdirSync(configDir);
    fs.writeFileSync(configFile, config);
    fs.writeFileSync(protectedFile, "protected bytes\n");
    const symlink = kind === "hash symlink";
    seedHash(hashFile, protectedFile);
    const script = buildSandboxConfigSyncScript(selection);
    const { nativeCalls } = runConfigSyncScript(
      script,
      homeDir,
      String(process.getuid?.()),
      kind === "host transaction" ? "root" : undefined,
      {
        validationStatus: kind === "invalid config" ? 1 : 0,
        expectedStatus: kind === "host transaction" ? 0 : 1,
      },
    );
    expect(nativeCalls.map((call) => call.split("|")[0])).toEqual(
      kind === "invalid config" ? ["config validate"] : [],
    );
    expect(fs.readFileSync(protectedFile, "utf8")).toBe("protected bytes\n");
    expect(fs.readFileSync(configFile, "utf8")).toBe(config);
    expect(symlink ? fs.readlinkSync(hashFile) : fs.readFileSync(hashFile, "utf8")).toBe(
      symlink ? protectedFile : "original hash\n",
    );
    expect(fs.lstatSync(hashFile).isSymbolicLink()).toBe(symlink);
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
