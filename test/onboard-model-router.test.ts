// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, it, vi } from "vitest";

import { getSandboxInferenceConfig } from "../src/lib/inference/config";
import {
  createProductionModelRouterCommandProvisioner,
  isManagedModelRouterCurrent,
  startModelRouter,
} from "../src/lib/onboard/model-router";
import {
  createModelRouterCommandProvisioner,
  type ModelRouterCommandDeps,
} from "../src/lib/onboard/model-router-command";
import type { SetupInference, SetupInferenceDeps } from "../src/lib/onboard/setup-inference.js";
import { run, runCapture } from "../src/lib/runner";
import {
  createProductionModelRouterInstallFixture,
  readRouterLaunchLog,
  stopTestProcess,
} from "./support/model-router-process-test-helpers.js";
import {
  createDirectSetupInferenceHarnessFactory,
  type DirectCommandEntry,
  withProcessEnv,
} from "./support/setup-inference-test-harness.js";

const onboard = require("../src/lib/onboard") as {
  createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
};
const createDirectSetupInferenceHarness = createDirectSetupInferenceHarnessFactory(
  onboard.createSetupInference,
);

const MODEL_ROUTER_FINGERPRINT_FILE = ".nemoclaw-source-fingerprint";
const MODEL_ROUTER_TEST_SOURCE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MODEL_ROUTER_TEST_VERSION = "0.1.0";
const NVIDIA_TEST_CREDENTIAL = "nvapi-TEST-NOT-A-REAL-ROUTER-KEY";

type PrepareCall = {
  venvDir: string;
  allowReplaceExisting?: boolean;
};

type CommandHarnessOptions = {
  installedFingerprint?: string;
  managedCommand?: boolean;
  pathCommand?: string;
  sourceFingerprint?: ModelRouterCommandDeps["sourceFingerprint"];
};

const tempDirs = new Set<string>();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const tmpDir of tempDirs) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function createCommandHarness(options: CommandHarnessOptions = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-router-command-"));
  tempDirs.add(tmpDir);
  const rootDir = path.join(tmpDir, "repo");
  const routerDir = path.join(rootDir, "nemoclaw-blueprint", "router", "llm-router");
  const venvDir = path.join(tmpDir, "model-router-venv");
  const defaultVenvDir = path.join(tmpDir, "default-model-router-venv");
  const managedCommand = path.join(venvDir, "bin", "model-router");
  const fingerprintPath = path.join(venvDir, MODEL_ROUTER_FINGERPRINT_FILE);
  const runCalls: string[][] = [];
  const runCaptureCalls: string[][] = [];
  const prepareCalls: PrepareCall[] = [];

  fs.mkdirSync(routerDir, { recursive: true });
  fs.writeFileSync(path.join(routerDir, "pyproject.toml"), "[project]\nname = 'model-router'\n");
  const writeManagedCommand = () => {
    fs.mkdirSync(path.dirname(managedCommand), { recursive: true });
    fs.writeFileSync(managedCommand, "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });
  };
  options.managedCommand ? writeManagedCommand() : undefined;
  const writeInstalledFingerprint = (fingerprint: string) => {
    fs.mkdirSync(venvDir, { recursive: true });
    fs.writeFileSync(fingerprintPath, `${fingerprint}\n`, { mode: 0o600 });
  };
  options.installedFingerprint === undefined
    ? undefined
    : writeInstalledFingerprint(options.installedFingerprint);

  const deps: ModelRouterCommandDeps = {
    run(command) {
      runCalls.push(command);
      command.includes("pip") && command.includes("install") && writeManagedCommand();
      return { status: 0 };
    },
    runCapture(command) {
      runCaptureCalls.push(command);
      return command[0] === "git" && command.includes("HEAD")
        ? MODEL_ROUTER_TEST_SOURCE_SHA
        : command[0] === "sh"
          ? (options.pathCommand ?? "")
          : "";
    },
    prepareModelRouterVenv(prepareOptions) {
      prepareCalls.push(prepareOptions);
      const venvPython = path.join(prepareOptions.venvDir, "bin", "python");
      fs.mkdirSync(path.dirname(venvPython), { recursive: true });
      fs.writeFileSync(venvPython, "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });
      return venvPython;
    },
    packageVersion: () => MODEL_ROUTER_TEST_VERSION,
    ...(options.sourceFingerprint ? { sourceFingerprint: options.sourceFingerprint } : {}),
  };
  const provisioner = createModelRouterCommandProvisioner(
    { rootDir, routerDir, venvDir, defaultVenvDir },
    deps,
  );

  return {
    fingerprintPath,
    managedCommand,
    prepareCalls,
    provisioner,
    routerDir,
    runCalls,
    runCaptureCalls,
    venvDir,
  };
}

function findCommand(commands: DirectCommandEntry[], pattern: RegExp): DirectCommandEntry {
  const command = commands.find((entry) => pattern.test(entry.command));
  assert.ok(command, JSON.stringify(commands));
  return command;
}

describe("onboard Model Router setup", () => {
  it("configures Model Router as a host provider while sandboxes keep inference.local", async () => {
    await withProcessEnv({ NVIDIA_INFERENCE_API_KEY: NVIDIA_TEST_CREDENTIAL }, async () => {
      const reconcileModelRouter = vi.fn(async () => undefined);
      const harness = createDirectSetupInferenceHarness({
        runOpenshell: (args) =>
          args[0] === "provider" && args[1] === "get" ? { status: 1 } : undefined,
        overrides: {
          isRoutedInferenceProvider: (provider: string) => provider === "nvidia-router",
          reconcileModelRouter,
        },
      });
      const routerPort = 44000 + (process.pid % 10000);

      await harness.setupInference(
        "router-box",
        "nvidia-routed",
        "nvidia-router",
        `http://host.openshell.internal:${routerPort}/v1`,
        "NVIDIA_INFERENCE_API_KEY",
      );

      assert.equal(reconcileModelRouter.mock.calls.length, 1);
      const providerCommand = findCommand(harness.commands, /provider create/);
      assert.match(providerCommand.command, /--name nvidia-router/);
      assert.match(providerCommand.command, /--credential NVIDIA_INFERENCE_API_KEY/);
      assert.match(
        providerCommand.command,
        new RegExp(`OPENAI_BASE_URL=http:\\/\\/host\\.openshell\\.internal:${routerPort}\\/v1`),
      );
      assert.doesNotMatch(providerCommand.command, new RegExp(NVIDIA_TEST_CREDENTIAL));
      assert.equal(providerCommand.env?.NVIDIA_INFERENCE_API_KEY, NVIDIA_TEST_CREDENTIAL);

      const inferenceCommand = findCommand(harness.commands, /inference set/);
      assert.match(inferenceCommand.command, /--provider nvidia-router/);
      assert.match(inferenceCommand.command, /--model nvidia-routed/);
      assert.deepEqual(getSandboxInferenceConfig("nvidia-routed", "nvidia-router"), {
        providerKey: "inference",
        primaryModelRef: "inference/nvidia-routed",
        inferenceBaseUrl: "https://inference.local/v1",
        inferenceApi: "openai-completions",
        inferenceCompat: null,
      });
    });
  });

  it("recognizes the current managed command through the production command adapter", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-router-current-"));
    tempDirs.add(tmpDir);
    const routerDir = path.join(tmpDir, "model-router-source");
    const venvDir = path.join(tmpDir, "model-router-venv");
    const managedCommand = path.join(venvDir, "bin", "model-router");
    const runGit = (args: string[]) => {
      const result = run(["git", ...args], { ignoreError: true, suppressOutput: true });
      assert.equal(result.status, 0, String(result.stderr || result.error || "git failed"));
    };
    runGit(["init", "--quiet", routerDir]);
    fs.writeFileSync(path.join(routerDir, "router.py"), "ROUTER_VERSION = 1\n");
    runGit(["-C", routerDir, "add", "router.py"]);
    runGit([
      "-C",
      routerDir,
      "-c",
      "user.name=NemoClaw Test",
      "-c",
      "user.email=nemoclaw-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "test: create model router source fixture",
    ]);
    const sourceHead = runCapture(["git", "-C", routerDir, "rev-parse", "HEAD"], {
      ignoreError: true,
    }).trim();
    assert.match(sourceHead, /^[0-9a-f]{40}$/i);
    assert.equal(
      runCapture(["git", "-C", routerDir, "rev-parse", "--show-toplevel"]).trim(),
      routerDir,
    );
    fs.mkdirSync(path.dirname(managedCommand), { recursive: true });
    fs.writeFileSync(managedCommand, "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(venvDir, MODEL_ROUTER_FINGERPRINT_FILE), `git:${sourceHead}\n`, {
      mode: 0o600,
    });

    assert.equal(isManagedModelRouterCurrent(routerDir, venvDir), true);
  });

  it("installs the managed command through the production provisioning adapters", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-router-install-"));
    tempDirs.add(tmpDir);
    const fixture = createProductionModelRouterInstallFixture(tmpDir);

    await withProcessEnv(
      {
        NEMOCLAW_MODEL_ROUTER_PYTHON: undefined,
        PATH: `${fixture.fakeBin}:/usr/bin:/bin`,
      },
      async () => {
        const provisioner = createProductionModelRouterCommandProvisioner(
          fixture.routerDir,
          fixture.venvDir,
        );
        assert.equal(provisioner.ensureModelRouterCommand(), fixture.managedCommand);
        assert.equal(provisioner.isManagedModelRouterCurrent(), true);
      },
    );

    const setupLog = fs.readFileSync(fixture.setupLog, "utf8");
    assert.match(setupLog, new RegExp(`python3 -m venv ${fixture.venvDir}`));
    assert.match(
      setupLog,
      new RegExp(
        `venv-python -m pip install --quiet --upgrade ${fixture.routerDir}\\[prefill,proxy\\]`,
      ),
    );
    assert.doesNotMatch(setupLog, /path-router/);
    assert.equal(
      fs.readFileSync(fixture.fingerprintPath, "utf8").trim(),
      `git:${fixture.sourceHead}`,
    );
  });

  it("starts the managed command through the production process adapters", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-router-start-"));
    tempDirs.add(tmpDir);
    const rootDir = path.join(tmpDir, "repo");
    const homeDir = path.join(tmpDir, "home");
    const routerCommand = path.join(tmpDir, "managed", "model-router");
    const launchLogPath = path.join(tmpDir, "router-launch.jsonl");
    const port = 45_678;
    const healthChecks: number[] = [];
    const sleepCalls: number[] = [];
    let healthProbe = 0;
    let pid: number | null = null;

    const blueprintDir = path.join(rootDir, "nemoclaw-blueprint");
    const poolConfigPath = path.join(blueprintDir, "router", "test-pool.yaml");
    const stateDir = path.join(homeDir, ".nemoclaw", "state");
    const litellmConfigPath = path.join(stateDir, "litellm-proxy.yaml");
    fs.mkdirSync(path.dirname(poolConfigPath), { recursive: true });
    fs.mkdirSync(path.dirname(routerCommand), { recursive: true });
    fs.writeFileSync(
      routerCommand,
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        "const env = {};",
        'for (const key of ["ROUTER_API_KEY", "OPENAI_API_KEY", "NEMOCLAW_PROVIDER_KEY"]) {',
        "  env[key] = process.env[key] || null;",
        "}",
        `fs.appendFileSync(${JSON.stringify(launchLogPath)}, JSON.stringify({ args, cwd: process.cwd(), env, pid: process.pid }) + "\\n");`,
        'if (args[0] === "proxy-config") process.exit(0);',
        'if (args[0] !== "proxy") process.exit(2);',
        "setTimeout(() => process.exit(0), 5000);",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    await withProcessEnv(
      {
        ROUTER_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
        NEMOCLAW_PROVIDER_KEY: undefined,
      },
      async () => {
        try {
          pid = await startModelRouter(
            {
              port,
              pool_config_path: "router/test-pool.yaml",
              credential_env: "ROUTER_API_KEY",
            },
            {
              rootDir,
              homeDir,
              ensureModelRouterCommand: () => routerCommand,
              resolveProviderCredential: (name) =>
                name === "ROUTER_API_KEY" ? "router-secret" : null,
              isRouterHealthy: async (routerPort) => {
                healthChecks.push(routerPort);
                healthProbe += 1;
                return healthProbe > 1;
              },
              sleep: async (milliseconds) => {
                sleepCalls.push(milliseconds);
              },
            },
          );
          const entries = await readRouterLaunchLog(launchLogPath, 2);
          const proxyConfig = entries.find(({ args }) => args[0] === "proxy-config");
          const proxy = entries.find(({ args }) => args[0] === "proxy");
          assert.ok(proxyConfig);
          assert.ok(proxy);
          assert.deepEqual(proxyConfig.args, [
            "proxy-config",
            "--config",
            poolConfigPath,
            "--output",
            litellmConfigPath,
          ]);
          assert.equal(proxyConfig.cwd, blueprintDir);
          assert.deepEqual(proxy.args, [
            "proxy",
            "--litellm-config",
            litellmConfigPath,
            "--router-config",
            poolConfigPath,
            "--host",
            "0.0.0.0",
            "--port",
            String(port),
          ]);
          assert.equal(proxy.cwd, blueprintDir);
          assert.deepEqual(proxy.env, {
            ROUTER_API_KEY: "router-secret",
            OPENAI_API_KEY: "router-secret",
            NEMOCLAW_PROVIDER_KEY: null,
          });
          assert.equal(proxy.pid, pid);
          assert.equal(fs.existsSync(stateDir), true);
          assert.deepEqual(healthChecks, [port, port]);
          assert.deepEqual(sleepCalls, [2000]);
        } finally {
          await stopTestProcess(pid);
        }
      },
    );
  });

  it("prepares managed Model Router dependencies instead of using PATH when managed command is absent", () => {
    const pathCommand = "/tmp/path-model-router";
    const harness = createCommandHarness({ pathCommand });

    assert.equal(harness.provisioner.ensureModelRouterCommand(), harness.managedCommand);
    assert.deepEqual(harness.prepareCalls, [
      { venvDir: harness.venvDir, allowReplaceExisting: false },
    ]);
    assert.deepEqual(harness.runCalls, [
      [
        path.join(harness.venvDir, "bin", "python"),
        "-m",
        "pip",
        "install",
        "--quiet",
        "--upgrade",
        `${harness.routerDir}[prefill,proxy]`,
      ],
    ]);
    assert.equal(
      harness.runCaptureCalls.some((command) => command[0] === "sh"),
      false,
      "PATH command discovery must not run when managed source is available",
    );
    assert.equal(
      fs.readFileSync(harness.fingerprintPath, "utf8").trim(),
      `git:${MODEL_ROUTER_TEST_SOURCE_SHA}`,
    );
  });

  it("prefers the managed Model Router command over PATH", () => {
    const harness = createCommandHarness({
      managedCommand: true,
      installedFingerprint: `git:${MODEL_ROUTER_TEST_SOURCE_SHA}`,
      pathCommand: "/tmp/path-model-router",
    });

    assert.equal(harness.provisioner.ensureModelRouterCommand(), harness.managedCommand);
    assert.deepEqual(harness.prepareCalls, []);
    assert.deepEqual(harness.runCalls, []);
    assert.equal(
      harness.runCaptureCalls.some((command) => command[0] === "sh"),
      false,
    );
  });

  it("refreshes stale managed Model Router command when source fingerprint changes", () => {
    const harness = createCommandHarness({
      managedCommand: true,
      installedFingerprint: "git:stale",
      pathCommand: "/tmp/path-model-router",
    });

    assert.equal(harness.provisioner.ensureModelRouterCommand(), harness.managedCommand);
    assert.deepEqual(harness.prepareCalls, [
      { venvDir: harness.venvDir, allowReplaceExisting: true },
    ]);
    assert.equal(harness.runCalls.length, 1);
    assert.equal(
      harness.runCaptureCalls.some((command) => command[0] === "sh"),
      false,
    );
    assert.equal(
      fs.readFileSync(harness.fingerprintPath, "utf8").trim(),
      `git:${MODEL_ROUTER_TEST_SOURCE_SHA}`,
    );
  });

  it("writes fallback fingerprint file when git source fingerprint is unavailable", () => {
    const harness = createCommandHarness({ sourceFingerprint: () => null });

    assert.equal(harness.provisioner.ensureModelRouterCommand(), harness.managedCommand);
    const fingerprint = fs.readFileSync(harness.fingerprintPath, "utf8").trim();
    assert.equal(fingerprint, `install:${MODEL_ROUTER_TEST_VERSION}`);
    assert.doesNotMatch(fingerprint, /^install:\d{13,}$/);
    assert.equal(harness.provisioner.isManagedModelRouterCurrent(), true);
  });
});
