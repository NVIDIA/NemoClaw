// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, it, vi } from "vitest";

import { getSandboxInferenceConfig } from "../../src/lib/inference/config";
import {
  createProductionModelRouterCommandProvisioner,
  isManagedModelRouterCurrent,
  poolTargetsOnlyNvidiaEndpoints,
  startModelRouter,
} from "../../src/lib/onboard/model-router";
import {
  createModelRouterCommandProvisioner,
  type ModelRouterCommandDeps,
} from "../../src/lib/onboard/model-router-command";
import type { SetupInference, SetupInferenceDeps } from "../../src/lib/onboard/setup-inference.js";
import { run, runCapture } from "../../src/lib/runner";
import {
  createProductionModelRouterInstallFixture,
  readRouterLaunchLog,
  stopTestProcess,
} from "../support/model-router-process-test-helpers.js";
import {
  createDirectSetupInferenceHarnessFactory,
  type DirectCommandEntry,
  withProcessEnv,
} from "../support/setup-inference-test-harness.js";

const onboard = require("../../src/lib/onboard") as {
  createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
};
const createDirectSetupInferenceHarness = createDirectSetupInferenceHarnessFactory(
  onboard.createSetupInference,
);

const MODEL_ROUTER_FINGERPRINT_FILE = ".nemoclaw-source-fingerprint";
const MODEL_ROUTER_TEST_SOURCE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MODEL_ROUTER_TEST_VERSION = "0.1.0";
const NVIDIA_TEST_CREDENTIAL = "nvapi-TEST-NOT-A-REAL-ROUTER-KEY";
const ROUTER_HEALTHY_BODY = JSON.stringify({
  healthy_endpoints: [{ api_base: "https://integrate.api.nvidia.com/v1" }],
  unhealthy_endpoints: [],
});

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
  vi.resetModules();
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
    // Hermetic disk-space gate: never statfs the host filesystem from tests.
    probeStorage: (targetPath, source) => ({
      ok: true,
      capacity: { availableBytes: 100n * 1024n ** 3n, path: targetPath, source },
    }),
    measureDirectorySize: () => 0n,
    formatStorageBytes: (bytes) => `${String(bytes / 1024n ** 3n)} GiB`,
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
      fs.realpathSync(runCapture(["git", "-C", routerDir, "rev-parse", "--show-toplevel"]).trim()),
      fs.realpathSync(routerDir),
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
          // Hermetic disk-space gate: the fixture venv lives under os.tmpdir(),
          // whose real free space must not decide this test.
          {
            probeStorage: (targetPath, source) => ({
              ok: true,
              capacity: { availableBytes: 100n * 1024n ** 3n, path: targetPath, source },
            }),
          },
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
    let pid: number | null = null;

    const blueprintDir = path.join(rootDir, "nemoclaw-blueprint");
    const poolConfigPath = path.join(blueprintDir, "router", "test-pool.yaml");
    const stateDir = path.join(homeDir, ".nemoclaw", "state");
    const litellmConfigPath = path.join(stateDir, "litellm-proxy.yaml");
    fs.mkdirSync(path.dirname(poolConfigPath), { recursive: true });
    fs.writeFileSync(
      poolConfigPath,
      'models:\n  - litellm_model: "openai/nvidia/test"\n    api_base: "https://integrate.api.nvidia.com/v1"\n',
    );
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
                return false;
              },
              getRouterHealthSnapshot: async (routerPort) => {
                healthChecks.push(routerPort);
                return { healthy: true, body: ROUTER_HEALTHY_BODY };
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
          assert.equal(fs.realpathSync(proxyConfig.cwd), fs.realpathSync(blueprintDir));
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
          assert.equal(fs.realpathSync(proxy.cwd), fs.realpathSync(blueprintDir));
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

  it("writes router output to an owner-only log in the state directory (#8962)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-router-log-"));
    tempDirs.add(tmpDir);
    const rootDir = path.join(tmpDir, "repo");
    const homeDir = path.join(tmpDir, "home");
    const routerCommand = path.join(tmpDir, "managed", "model-router");
    const port = 45_692;
    let pid: number | null = null;

    fs.mkdirSync(path.join(rootDir, "nemoclaw-blueprint", "router"), { recursive: true });
    fs.mkdirSync(path.dirname(routerCommand), { recursive: true });
    fs.writeFileSync(
      routerCommand,
      [
        `#!${process.execPath}`,
        "const args = process.argv.slice(2);",
        'if (args[0] === "proxy-config") process.exit(0);',
        'console.error("ROUTER-STDERR-MARKER: endpoint auth failed");',
        "setTimeout(() => process.exit(0), 5000);",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      pid = await startModelRouter(
        { port, pool_config_path: "router/test-pool.yaml" },
        {
          rootDir,
          homeDir,
          ensureModelRouterCommand: () => routerCommand,
          resolveProviderCredential: () => null,
          isRouterHealthy: async () => false,
          getRouterHealthSnapshot: async () => ({ healthy: true, body: ROUTER_HEALTHY_BODY }),
          sleep: async () => undefined,
        },
      );
      const logPath = path.join(homeDir, ".nemoclaw", "state", "model-router.log");
      await vi.waitFor(() => {
        assert.match(
          fs.readFileSync(logPath, "utf8"),
          /ROUTER-STDERR-MARKER: endpoint auth failed/,
        );
      });
      assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
    } finally {
      await stopTestProcess(pid);
    }
  });

  it("starts a Model Router whose health check passes after 61 retry intervals", async () => {
    const pid = 12_345;
    const sleep = vi.fn(async () => undefined);
    const terminateProcess = vi.fn();
    let healthProbe = 0;

    const startedPid = await startModelRouter(
      { port: 45_679, pool_config_path: "router/test-pool.yaml" },
      {
        rootDir: "/test/repo",
        homeDir: "/test/home",
        ensureModelRouterCommand: () => "/test/model-router",
        mkdirSync: () => undefined,
        runProxyConfig: () => ({ status: 0 }),
        spawnProxy: () => ({
          pid,
          onError: () => undefined,
          onExit: () => undefined,
          unref: () => undefined,
        }),
        resolveProviderCredential: () => null,
        buildSubprocessEnv: () => ({}),
        isRouterHealthy: async () => false,
        getRouterHealthSnapshot: async () => {
          healthProbe += 1;
          return { healthy: healthProbe > 60, body: ROUTER_HEALTHY_BODY };
        },
        sleep,
        isProcessAlive: () => true,
        terminateProcess,
        getProviderKey: () => "",
      },
    );

    assert.equal(startedPid, pid);
    assert.equal(healthProbe, 61);
    assert.equal(sleep.mock.calls.length, 61);
    assert.equal(terminateProcess.mock.calls.length, 0);
  });

  it("requests termination for a Model Router that stays unhealthy after 300 retry intervals", async () => {
    const pid = 12_345;
    const sleep = vi.fn(async () => undefined);
    const terminateProcess = vi.fn();
    const getRouterHealthSnapshot = vi.fn(async () => ({ healthy: false, body: null }));

    await assert.rejects(
      startModelRouter(
        { port: 45_680, pool_config_path: "router/test-pool.yaml" },
        {
          rootDir: "/test/repo",
          homeDir: "/test/home",
          ensureModelRouterCommand: () => "/test/model-router",
          mkdirSync: () => undefined,
          runProxyConfig: () => ({ status: 0 }),
          spawnProxy: () => ({
            pid,
            onError: () => undefined,
            onExit: () => undefined,
            unref: () => undefined,
          }),
          resolveProviderCredential: () => null,
          buildSubprocessEnv: () => ({}),
          isRouterHealthy: async () => false,
          getRouterHealthSnapshot,
          sleep,
          isProcessAlive: () => true,
          terminateProcess,
          getProviderKey: () => "",
        },
      ),
      /failed to become healthy on port 45680 within 600 seconds \(completed health checks: 300\)/,
    );

    assert.equal(getRouterHealthSnapshot.mock.calls.length, 301);
    assert.equal(sleep.mock.calls.length, 300);
    assert.deepEqual(terminateProcess.mock.calls, [[pid]]);
  });

  it("sets OPENAI_API_KEY to the routed credential when an ambient OPENAI_API_KEY exists (#8962)", async () => {
    const pid = 12_345;
    let spawnedEnv: Record<string, string> | null = null;

    await startModelRouter(
      { port: 45_690, pool_config_path: "router/test-pool.yaml", credential_env: "ROUTER_API_KEY" },
      {
        rootDir: "/test/repo",
        homeDir: "/test/home",
        ensureModelRouterCommand: () => "/test/model-router",
        mkdirSync: () => undefined,
        runProxyConfig: () => ({ status: 0 }),
        spawnProxy: (_command, _args, options) => {
          spawnedEnv = options.env;
          return {
            pid,
            onError: () => undefined,
            onExit: () => undefined,
            unref: () => undefined,
          };
        },
        readPoolConfig: () =>
          'models:\n  - litellm_model: "openai/nvidia/test"\n    api_base: "https://integrate.api.nvidia.com/v1"\n',
        resolveProviderCredential: (name) =>
          ({ ROUTER_API_KEY: "router-secret", OPENAI_API_KEY: "stale-openai" })[name] ?? null,
        buildSubprocessEnv: (extra) => ({ ...extra }),
        isRouterHealthy: async () => false,
        getRouterHealthSnapshot: async () => ({ healthy: true, body: ROUTER_HEALTHY_BODY }),
        sleep: async () => undefined,
        isProcessAlive: () => true,
        terminateProcess: () => undefined,
        getProviderKey: () => "",
      },
    );

    assert.deepEqual(spawnedEnv, {
      ROUTER_API_KEY: "router-secret",
      OPENAI_API_KEY: "router-secret",
    });
  });

  it.each([
    null,
    "not: [valid",
    "routing: {}\n",
    "models: []\n",
    'models:\n  - litellm_model: "openai/gpt-test"\n',
    'models:\n  - api_base: ""\n',
    'models:\n  - api_base: "not-a-url"\n',
    'models:\n  - api_base: "http://integrate.api.nvidia.com/v1"\n',
  ])("does not classify uncertain pool shapes as NVIDIA-only [%s] (#8962)", (pool) => {
    assert.equal(poolTargetsOnlyNvidiaEndpoints(pool), false, String(pool));
  });

  it("classifies the shipped NVIDIA pool as NVIDIA-only (#8962)", () => {
    const shippedPool = [
      "models:",
      "  - name: nemotron",
      '    api_base: "https://integrate.api.nvidia.com/v1"',
      "",
    ].join("\n");

    assert.equal(poolTargetsOnlyNvidiaEndpoints(shippedPool), true);
  });

  it("appends the last router health error and log path to the startup timeout error (#8962)", async () => {
    const pid = 12_345;
    const unhealthyBody = JSON.stringify({
      healthy_endpoints: [],
      unhealthy_endpoints: [
        { api_base: "https://integrate.api.nvidia.com/v1", error: "AuthenticationError: bad key" },
      ],
    });

    await assert.rejects(
      startModelRouter(
        { port: 45_691, pool_config_path: "router/test-pool.yaml" },
        {
          rootDir: "/test/repo",
          homeDir: "/test/home",
          ensureModelRouterCommand: () => "/test/model-router",
          mkdirSync: () => undefined,
          runProxyConfig: () => ({ status: 0 }),
          spawnProxy: () => ({
            pid,
            onError: () => undefined,
            onExit: () => undefined,
            unref: () => undefined,
          }),
          resolveProviderCredential: () => null,
          buildSubprocessEnv: () => ({}),
          isRouterHealthy: async () => false,
          getRouterHealthSnapshot: async () => ({ healthy: false, body: unhealthyBody }),
          openRouterLog: () => ({ fd: 99, startOffset: 0 }),
          closeRouterLog: () => undefined,
          readRouterLogTail: () => "",
          sleep: async () => undefined,
          isProcessAlive: () => true,
          terminateProcess: () => undefined,
          getProviderKey: () => "",
        },
      ),
      /failed to become healthy on port 45691[\s\S]*last health error: AuthenticationError: bad key[\s\S]*model-router\.log/,
    );
  });

  it("returns the router PID when the final health snapshot proves recovery (#8962)", async () => {
    const pid = 12_345;
    const terminateProcess = vi.fn();

    const startedPid = await startModelRouter(
      { port: 45_693, pool_config_path: "router/test-pool.yaml" },
      {
        rootDir: "/test/repo",
        homeDir: "/test/home",
        ensureModelRouterCommand: () => "/test/model-router",
        mkdirSync: () => undefined,
        runProxyConfig: () => ({ status: 0 }),
        spawnProxy: () => ({
          pid,
          onError: () => undefined,
          onExit: () => undefined,
          unref: () => undefined,
        }),
        resolveProviderCredential: () => null,
        buildSubprocessEnv: () => ({}),
        isRouterHealthy: async () => false,
        // /health outruns the poll's 3-second budget and answers only within
        // the 30-second final-snapshot budget.
        getRouterHealthSnapshot: async (_port: number, timeoutMs = 0) => ({
          healthy: timeoutMs >= 30_000,
          body: timeoutMs >= 30_000 ? ROUTER_HEALTHY_BODY : null,
        }),
        sleep: async () => undefined,
        isProcessAlive: () => true,
        terminateProcess,
        getProviderKey: () => "",
      },
    );

    assert.equal(startedPid, pid);
    assert.equal(terminateProcess.mock.calls.length, 0);
  });

  it("redacts a credential-shaped health error from the startup error (#8962)", async () => {
    const pid = 12_345;
    const secret = "nvapi-HEALTHSECRETHEALTHSECRETHEALTHSECRETHEALTH";
    const credentialBody = JSON.stringify({
      healthy_endpoints: [],
      unhealthy_endpoints: [{ error: `AuthenticationError: api_key ${secret} invalid` }],
    });

    await assert.rejects(
      startModelRouter(
        { port: 45_697, pool_config_path: "router/test-pool.yaml" },
        {
          rootDir: "/test/repo",
          homeDir: "/test/home",
          ensureModelRouterCommand: () => "/test/model-router",
          mkdirSync: () => undefined,
          runProxyConfig: () => ({ status: 0 }),
          spawnProxy: () => ({
            pid,
            onError: () => undefined,
            onExit: () => undefined,
            unref: () => undefined,
          }),
          resolveProviderCredential: () => null,
          buildSubprocessEnv: () => ({}),
          isRouterHealthy: async () => false,
          getRouterHealthSnapshot: async () => ({ healthy: false, body: credentialBody }),
          sleep: async () => undefined,
          isProcessAlive: () => true,
          terminateProcess: () => undefined,
          getProviderKey: () => "",
        },
      ),
      (error: Error) => {
        assert.match(
          error.message,
          /last health error: AuthenticationError: api_key <REDACTED> invalid/,
        );
        assert.doesNotMatch(error.message, /HEALTHSECRET/);
        assert.doesNotMatch(error.message, /nvapi-HEAL/);
        return true;
      },
    );
  });

  it("still fails when the poll and final snapshot are 2xx with zero healthy endpoints (#8962)", async () => {
    const pid = 12_345;
    const terminateProcess = vi.fn();
    const allUnhealthyBody = JSON.stringify({
      healthy_endpoints: [],
      unhealthy_endpoints: [{ error: "AuthenticationError: bad key" }],
    });

    await assert.rejects(
      startModelRouter(
        { port: 45_694, pool_config_path: "router/test-pool.yaml" },
        {
          rootDir: "/test/repo",
          homeDir: "/test/home",
          ensureModelRouterCommand: () => "/test/model-router",
          mkdirSync: () => undefined,
          runProxyConfig: () => ({ status: 0 }),
          spawnProxy: () => ({
            pid,
            onError: () => undefined,
            onExit: () => undefined,
            unref: () => undefined,
          }),
          resolveProviderCredential: () => null,
          buildSubprocessEnv: () => ({}),
          // The pre-spawn port guard calls isRouterHealthy without a timeout.
          // Return true for timeout-bearing calls so a regression to the old
          // boolean startup poll cannot accept zero healthy endpoints.
          isRouterHealthy: async (_port: number, timeoutMs) => timeoutMs !== undefined,
          getRouterHealthSnapshot: async () => ({ healthy: true, body: allUnhealthyBody }),
          sleep: async () => undefined,
          isProcessAlive: () => true,
          terminateProcess,
          getProviderKey: () => "",
        },
      ),
      /failed to become healthy on port 45694[\s\S]*last health error: AuthenticationError: bad key/,
    );

    assert.deepEqual(terminateProcess.mock.calls, [[pid]]);
  });

  it("fully redacts credential material from the startup error log tail (#8962)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-router-redact-"));
    tempDirs.add(tmpDir);
    const rootDir = path.join(tmpDir, "repo");
    const homeDir = path.join(tmpDir, "home");
    const logPath = path.join(homeDir, ".nemoclaw", "state", "model-router.log");
    const secret = "nvapi-SECRETSECRETSECRETSECRETSECRETSECRETSECRET";
    const pid = 12_345;

    await assert.rejects(
      startModelRouter(
        { port: 45_696, pool_config_path: "router/test-pool.yaml" },
        {
          rootDir,
          homeDir,
          ensureModelRouterCommand: () => "/test/model-router",
          runProxyConfig: () => ({ status: 0 }),
          spawnProxy: () => {
            fs.appendFileSync(logPath, `AuthenticationError: api_key ${secret} rejected\n`);
            return {
              pid,
              onError: () => undefined,
              onExit: () => undefined,
              unref: () => undefined,
            };
          },
          resolveProviderCredential: () => null,
          buildSubprocessEnv: () => ({}),
          isRouterHealthy: async () => false,
          getRouterHealthSnapshot: async () => ({ healthy: false, body: null }),
          sleep: async () => undefined,
          isProcessAlive: () => false,
          terminateProcess: () => undefined,
          getProviderKey: () => "",
        },
      ),
      (error: Error) => {
        assert.match(error.message, /Last router log lines:/);
        assert.match(error.message, /AuthenticationError: api_key <REDACTED> rejected/);
        assert.doesNotMatch(error.message, /SECRETSECRET/);
        assert.doesNotMatch(error.message, /nvapi-SECR/);
        return true;
      },
    );
  });

  it.each(
    Array.from(
      [
        [
          "models:",
          "  - name: custom-openai",
          '    litellm_model: "openai/gpt-test"',
          '    api_base: "https://api.openai.com/v1"',
          "",
        ].join("\n"),
        'models:\n  - litellm_model: "openai/gpt-test"\n',
      ],
      (value) => [value],
    ),
  )(
    "keeps an ambient OPENAI_API_KEY for non-NVIDIA and unproven pools [case %#] (#8962)",
    async (pool) => {
      const pid = 12_345;
      let spawnedEnv: Record<string, string> | null = null;

      await startModelRouter(
        {
          port: 45_695,
          pool_config_path: "router/test-pool.yaml",
          credential_env: "ROUTER_API_KEY",
        },
        {
          rootDir: "/test/repo",
          homeDir: "/test/home",
          ensureModelRouterCommand: () => "/test/model-router",
          mkdirSync: () => undefined,
          runProxyConfig: () => ({ status: 0 }),
          spawnProxy: (_command, _args, options) => {
            spawnedEnv = options.env;
            return {
              pid,
              onError: () => undefined,
              onExit: () => undefined,
              unref: () => undefined,
            };
          },
          readPoolConfig: () => pool,
          resolveProviderCredential: (name) =>
            ({ ROUTER_API_KEY: "router-secret", OPENAI_API_KEY: "operator-openai" })[name] ?? null,
          buildSubprocessEnv: (extra) => ({ ...extra }),
          isRouterHealthy: async () => false,
          getRouterHealthSnapshot: async () => ({ healthy: true, body: ROUTER_HEALTHY_BODY }),
          sleep: async () => undefined,
          isProcessAlive: () => true,
          terminateProcess: () => undefined,
          getProviderKey: () => "",
        },
      );

      assert.deepEqual(spawnedEnv, {
        ROUTER_API_KEY: "router-secret",
        OPENAI_API_KEY: "operator-openai",
      });
    },
  );

  it("preserves routed credential fallback for an unproven pool (#8962)", async () => {
    const pid = 12_345;
    let spawnedEnv: Record<string, string> | null = null;

    await startModelRouter(
      {
        port: 45_699,
        pool_config_path: "router/test-pool.yaml",
        credential_env: "ROUTER_API_KEY",
      },
      {
        rootDir: "/test/repo",
        homeDir: "/test/home",
        ensureModelRouterCommand: () => "/test/model-router",
        mkdirSync: () => undefined,
        runProxyConfig: () => ({ status: 0 }),
        spawnProxy: (_command, _args, options) => {
          spawnedEnv = options.env;
          return {
            pid,
            onError: () => undefined,
            onExit: () => undefined,
            unref: () => undefined,
          };
        },
        readPoolConfig: () => 'models:\n  - litellm_model: "openai/gpt-test"\n',
        resolveProviderCredential: (name) => (name === "ROUTER_API_KEY" ? "router-secret" : null),
        buildSubprocessEnv: (extra) => ({ ...extra }),
        isRouterHealthy: async () => false,
        getRouterHealthSnapshot: async () => ({ healthy: true, body: ROUTER_HEALTHY_BODY }),
        sleep: async () => undefined,
        isProcessAlive: () => true,
        terminateProcess: () => undefined,
        getProviderKey: () => "",
      },
    );

    assert.deepEqual(spawnedEnv, {
      ROUTER_API_KEY: "router-secret",
      OPENAI_API_KEY: "router-secret",
    });
  });

  it("stops when the 10-minute Model Router startup deadline expires", async () => {
    const pid = 12_345;
    const terminateProcess = vi.fn();
    let nowMs = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      nowMs += milliseconds;
    });
    const getRouterHealthSnapshot = vi.fn(async (_port: number, timeoutMs = 0) => {
      nowMs += timeoutMs;
      return { healthy: false, body: null };
    });

    await assert.rejects(
      startModelRouter(
        { port: 45_681, pool_config_path: "router/test-pool.yaml" },
        {
          rootDir: "/test/repo",
          homeDir: "/test/home",
          ensureModelRouterCommand: () => "/test/model-router",
          mkdirSync: () => undefined,
          runProxyConfig: () => ({ status: 0 }),
          spawnProxy: () => ({
            pid,
            onError: () => undefined,
            onExit: () => undefined,
            unref: () => undefined,
          }),
          resolveProviderCredential: () => null,
          buildSubprocessEnv: () => ({}),
          isRouterHealthy: async () => false,
          getRouterHealthSnapshot,
          sleep,
          now: () => nowMs,
          isProcessAlive: () => true,
          terminateProcess,
          getProviderKey: () => "",
        },
      ),
      // The poll owns 570 seconds and the final diagnostic snapshot owns the
      // remaining 30, so a failed startup never exceeds the 600 seconds the
      // error reports (#8962).
      /failed to become healthy on port 45681 within 600 seconds \(completed health checks: 114\)/,
    );

    assert.equal(nowMs, 600_000);
    assert.equal(getRouterHealthSnapshot.mock.calls.length, 115);
    assert.equal(sleep.mock.calls.length, 114);
    assert.deepEqual(terminateProcess.mock.calls, [[pid]]);
  });

  it("writes router state beneath the selected nondefault gateway root", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-router-port-"));
    tempDirs.add(tmpDir);
    const rootDir = path.join(tmpDir, "repo");
    const homeDir = path.join(tmpDir, "home");
    const expectedStateDir = path.join(homeDir, ".nemoclaw", "gateways", "9123", "state");
    const expectedConfig = path.join(expectedStateDir, "litellm-proxy.yaml");
    const mkdirSync = vi.fn();
    const proxyConfigArgs: string[][] = [];
    const proxyArgs: string[][] = [];
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "9123");
    vi.resetModules();
    const freshModelRouter = await import("../../src/lib/onboard/model-router");

    const pid = await freshModelRouter.startModelRouter(
      { port: 45_679, pool_config_path: "router/test-pool.yaml" },
      {
        rootDir,
        homeDir,
        ensureModelRouterCommand: () => "/test/model-router",
        mkdirSync,
        runProxyConfig: (_command, args) => {
          proxyConfigArgs.push(args);
          return { status: 0 };
        },
        spawnProxy: (_command, args) => {
          proxyArgs.push(args);
          return {
            pid: 12_345,
            onError: () => undefined,
            onExit: () => undefined,
            unref: () => undefined,
          };
        },
        resolveProviderCredential: () => null,
        buildSubprocessEnv: () => ({}),
        isRouterHealthy: async () => false,
        getRouterHealthSnapshot: async () => ({ healthy: true, body: ROUTER_HEALTHY_BODY }),
        sleep: async () => undefined,
        isProcessAlive: () => true,
        terminateProcess: () => undefined,
        getProviderKey: () => "",
      },
    );

    assert.equal(pid, 12_345);
    assert.deepEqual(mkdirSync.mock.calls, [[expectedStateDir]]);
    assert.equal(proxyConfigArgs[0]?.at(-1), expectedConfig);
    assert.equal(proxyArgs[0]?.[2], expectedConfig);
  });

  it.each([
    ["gateways", [".nemoclaw", "gateways"]],
    ["selected port", [".nemoclaw", "gateways", "9123"]],
    ["state", [".nemoclaw", "gateways", "9123", "state"]],
  ] as const)(
    "rejects a symlinked %s path before generating router config",
    async (_label, parts) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-router-symlink-"));
      tempDirs.add(tmpDir);
      const homeDir = path.join(tmpDir, "home");
      const controlled = path.join(tmpDir, "controlled");
      const symlinkPath = path.join(homeDir, ...parts);
      fs.mkdirSync(path.dirname(symlinkPath), { recursive: true });
      fs.mkdirSync(controlled);
      fs.symlinkSync(controlled, symlinkPath, "dir");
      vi.stubEnv("HOME", homeDir);
      vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "9123");
      vi.resetModules();
      const freshModelRouter = await import("../../src/lib/onboard/model-router");
      const runProxyConfig = vi.fn(() => ({ status: 0 }));

      await assert.rejects(
        freshModelRouter.startModelRouter(
          { port: 45_680, pool_config_path: "router/test-pool.yaml" },
          {
            rootDir: path.join(tmpDir, "repo"),
            homeDir,
            ensureModelRouterCommand: () => "/test/model-router",
            runProxyConfig,
          },
        ),
        /symbolic link/i,
      );

      assert.equal(runProxyConfig.mock.calls.length, 0);
      assert.deepEqual(fs.readdirSync(controlled), []);
    },
  );

  it("revalidates the state directory after creation before generating router config", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-router-race-"));
    tempDirs.add(tmpDir);
    const homeDir = path.join(tmpDir, "home");
    const controlled = path.join(tmpDir, "controlled");
    const stateDir = path.join(homeDir, ".nemoclaw", "gateways", "9123", "state");
    fs.mkdirSync(controlled, { recursive: true });
    vi.stubEnv("HOME", homeDir);
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "9123");
    vi.resetModules();
    const freshModelRouter = await import("../../src/lib/onboard/model-router");
    const runProxyConfig = vi.fn(() => ({ status: 0 }));

    await assert.rejects(
      freshModelRouter.startModelRouter(
        { port: 45_681, pool_config_path: "router/test-pool.yaml" },
        {
          rootDir: path.join(tmpDir, "repo"),
          homeDir,
          ensureModelRouterCommand: () => "/test/model-router",
          mkdirSync: () => {
            fs.mkdirSync(path.dirname(stateDir), { recursive: true });
            fs.symlinkSync(controlled, stateDir, "dir");
          },
          runProxyConfig,
        },
      ),
      /symbolic link/i,
    );

    assert.equal(runProxyConfig.mock.calls.length, 0);
    assert.deepEqual(fs.readdirSync(controlled), []);
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
