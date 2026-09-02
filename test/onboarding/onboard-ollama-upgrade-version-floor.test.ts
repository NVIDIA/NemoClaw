// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";

import { resetOllamaHostCache } from "../../src/lib/inference/local.js";
import { MIN_OLLAMA_VERSION } from "../../src/lib/inference/ollama-version.js";
import {
  type InstallOllamaLinuxOptions,
  installOllamaOnLinux,
} from "../../src/lib/onboard/install-ollama-linux.js";
import {
  assertOllamaUpgradeApplied,
  resolveOllamaInstallMenuEntry,
} from "../../src/lib/onboard/ollama-install-menu.js";
import { createSetupNimOllamaHandlers } from "../../src/lib/onboard/setup-nim-ollama.js";
import type { SetupNimSelectionState } from "../../src/lib/onboard/setup-nim-selection.js";

type SetupNimOllamaDeps = Parameters<typeof createSetupNimOllamaHandlers>[0];

const STALE_VERSION = "0.23.4";

function successfulRunShellResult(): ReturnType<
  NonNullable<InstallOllamaLinuxOptions["runShellImpl"]>
> {
  return {
    pid: 1,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
  };
}

function makeInstallOptions(
  overrides: Partial<InstallOllamaLinuxOptions> = {},
): InstallOllamaLinuxOptions {
  return {
    isNonInteractive: () => true,
    getEuid: () => 1000,
    isTty: () => false,
    homedir: () => "/home/test",
    arch: () => "arm64",
    canSudoNonInteractive: () => true,
    runCaptureImpl: vi.fn().mockReturnValue(""),
    runCaptureExImpl: vi
      .fn()
      .mockReturnValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
    runShellImpl: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "", error: null }),
    waitForHttpImpl: vi.fn().mockReturnValue(true),
    sleepSecondsImpl: vi.fn(),
    ensureManagedOllamaLoopbackSystemdOverrideImpl: vi.fn().mockReturnValue("ready"),
    fileExistsImpl: vi.fn().mockReturnValue(false),
    readFileImpl: vi.fn().mockReturnValue(""),
    recordUserLocalOllamaOwnershipImpl: vi.fn(),
    removeUserLocalOllamaOwnershipImpl: vi.fn(),
    log: vi.fn(),
    errorLog: vi.fn(),
    ...overrides,
  };
}

function makeSelectionState(): SetupNimSelectionState {
  return {
    model: null,
    provider: "nvidia-prod",
    endpointUrl: null,
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    nimContainer: null,
    allowToolsIncompatible: false,
    skipHostInferenceSmoke: false,
  };
}

function makeOllamaDeps(overrides: Partial<SetupNimOllamaDeps> = {}): SetupNimOllamaDeps {
  const processStub = {
    platform: "linux",
    exit(code?: number): never {
      throw new Error(`Unexpected process.exit(${String(code)})`);
    },
  } as NodeJS.Process;
  return {
    OLLAMA_PORT: 11434,
    OLLAMA_PROXY_PORT: 11435,
    process: processStub,
    isNonInteractive: () => true,
    prompt: async () => "",
    checkOllamaPortsOrWarn: () => true,
    ensureOllamaLoopbackSystemdOverride: () => "not-applicable",
    runOllamaStartupOrGate: () => ({ kind: "ready" }),
    shouldFrontOllamaWithProxy: () => false,
    getLocalProviderBaseUrl: () => "http://host.docker.internal:11434/v1",
    selectAndValidateOllamaModel: async () => ({
      outcome: "selected",
      model: "qwen3:8b",
      allowToolsIncompatible: false,
    }),
    installOllamaOnWindowsHost: async () => ({ ok: true }),
    awaitWindowsOllamaReady: () => true,
    setupWindowsOllamaLoopbackBinding: () => true,
    printWindowsOllamaTimeoutDiagnostics: () => {},
    resetOllamaHostCache: () => {},
    installOllamaOnMacOS: () => ({ ok: true }),
    installOllamaOnLinux: () => ({ ok: true }),
    abortNonInteractive(message: string): never {
      throw new Error(message);
    },
    assertOllamaUpgradeApplied: () => ({ ok: true }),
    ...overrides,
  };
}

describe("onboard Ollama upgrade version floor", () => {
  it("asks the installer for the required version and reports honestly when it is not delivered (#9276)", async () => {
    const menu = resolveOllamaInstallMenuEntry({
      hasOllama: true,
      ollamaRunning: true,
      ollamaHost: "127.0.0.1",
      hasWindowsOllama: false,
      installedOllamaVersion: STALE_VERSION,
      runningOllamaVersion: STALE_VERSION,
      platform: "linux",
      isWsl: false,
    });
    assert.equal(menu.hasUpgradableOllama, true);
    const commands: string[] = [];
    const runCapture = (command: readonly string[]) => {
      const rendered = command.join(" ");
      switch (true) {
        case rendered.includes("ollama --version"):
          return `ollama version is ${STALE_VERSION}`;
        case rendered.includes("/api/version"):
          return `{"version":"${STALE_VERSION}"}`;
        case command.at(-1) === "zstd":
          return "/usr/bin/zstd";
        default:
          return "";
      }
    };
    const errors: string[] = [];
    const errorLog = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });
    const { handleInstallOllamaSelection } = createSetupNimOllamaHandlers(
      makeOllamaDeps({
        installOllamaOnLinux: () =>
          installOllamaOnLinux(
            makeInstallOptions({
              modeOverride: "system",
              isUpgrade: true,
              runCaptureImpl: runCapture,
              runShellImpl: (command) => {
                commands.push(command);
                return successfulRunShellResult();
              },
            }),
          ),
        assertOllamaUpgradeApplied: (selection) => {
          const outcome = assertOllamaUpgradeApplied(selection, runCapture);
          return outcome.ok
            ? { ok: true as const }
            : { ok: false as const, message: outcome.message ?? "Ollama upgrade failed." };
        },
      }),
    );

    try {
      await assert.rejects(
        handleInstallOllamaSelection(null, "qwen3:8b", null, makeSelectionState(), menu),
        /Unexpected process\.exit\(1\)/,
      );
      const installer = commands.find((command) => command.includes("OLLAMA_VERSION="));
      assert.ok(installer);
      assert.ok(installer.includes(`OLLAMA_VERSION=${MIN_OLLAMA_VERSION}`));
      assert.ok(!installer.includes("curl"));
      assert.ok(!installer.includes("|"));
      const surfaced = errors.join("\n");
      assert.ok(surfaced.includes(`did not deliver ${MIN_OLLAMA_VERSION} on this host`));
      assert.ok(!surfaced.includes("systemctl restart ollama"));
    } finally {
      errorLog.mockRestore();
      resetOllamaHostCache();
    }
  });

  it("restarts a stale daemon without downgrading a newer installed binary (#9276)", async () => {
    const currentVersion = "0.40.0";
    const menu = resolveOllamaInstallMenuEntry({
      hasOllama: true,
      ollamaRunning: true,
      ollamaHost: "127.0.0.1",
      hasWindowsOllama: false,
      installedOllamaVersion: currentVersion,
      runningOllamaVersion: STALE_VERSION,
      platform: "linux",
      isWsl: false,
    });
    assert.equal(menu.hasUpgradableOllama, true);
    assert.equal(menu.binaryNeedsUpgrade, false);

    const responses = new Map<string, string>([
      [
        JSON.stringify([
          "curl",
          "-sf",
          "--connect-timeout",
          "2",
          "--max-time",
          "5",
          "http://127.0.0.1:11434/api/version",
        ]),
        JSON.stringify({ version: currentVersion }),
      ],
      [JSON.stringify(["ollama", "--version"]), `ollama version is ${currentVersion}`],
    ]);
    const runCapture = (command: readonly string[]) => responses.get(JSON.stringify(command)) ?? "";
    const commands: string[] = [];
    const ensureOverride = vi.fn().mockReturnValue("ready");
    const install = vi.fn((options: Parameters<SetupNimOllamaDeps["installOllamaOnLinux"]>[0]) =>
      installOllamaOnLinux(
        makeInstallOptions({
          ...options,
          modeOverride: "system",
          runCaptureImpl: runCapture,
          runShellImpl: (command) => {
            commands.push(command);
            return successfulRunShellResult();
          },
          ensureManagedOllamaLoopbackSystemdOverrideImpl: ensureOverride,
        }),
      ),
    );
    const { handleInstallOllamaSelection } = createSetupNimOllamaHandlers(
      makeOllamaDeps({
        installOllamaOnLinux: install,
        assertOllamaUpgradeApplied: (selection) => {
          const outcome = assertOllamaUpgradeApplied(selection, runCapture);
          return outcome.ok
            ? { ok: true as const }
            : { ok: false as const, message: outcome.message ?? "Ollama upgrade failed." };
        },
      }),
    );

    const result = await handleInstallOllamaSelection(
      null,
      "qwen3:8b",
      null,
      makeSelectionState(),
      menu,
    );
    assert.equal(result, "selected");
    assert.equal(install.mock.calls[0]?.[0].restartOnly, true);
    assert.ok(!commands.some((command) => command.includes("ollama.com/install.sh")));
    assert.equal(ensureOverride.mock.calls[0]?.[0].isUpgrade, true);
  });
});
