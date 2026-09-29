// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import {
  type CommandRunner,
  GatewayClient,
  HostCliClient,
  SandboxClient,
} from "../fixtures/clients/index.ts";
import { buildGatewayRuntimeStartScript } from "../fixtures/gateway-runtime-start.ts";
import type { E2ETargetFixtures } from "../fixtures/e2e-test.ts";
import { RuntimeProviderPrerequisite } from "../fixtures/runtime-provider.ts";
import type { NemoClawInstance } from "../fixtures/phases/index.ts";
import {
  dcodeInvalidCredentialRebuildOptionsFromRegistryEntry,
  type LifecycleCleanup,
  LifecyclePhaseFixture,
} from "../fixtures/phases/lifecycle.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../fixtures/shell-probe.ts";

interface RunnerCall {
  command: string;
  args: string[];
  options?: ShellProbeRunOptions;
}

interface CleanupCall {
  name: string;
  run: () => Promise<void> | void;
}

const stoppedGatewayUserService =
  "NEMOCLAW_E2E_STOPPED_GATEWAY_USER_SERVICE=systemd:nemoclaw-openshell-gateway.service\n";

function shellResult(exitCode: number, output = ""): ShellProbeResult {
  return {
    command: [],
    exitCode,
    signal: null,
    timedOut: false,
    stdout: exitCode === 0 ? output : "",
    stderr: exitCode === 0 ? "" : output,
    artifacts: {
      stdout: "/tmp/stdout.txt",
      stderr: "/tmp/stderr.txt",
      result: "/tmp/result.json",
    },
  };
}

class FakeRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];
  private readonly responses: ShellProbeResult[] = [];

  enqueue(response: ShellProbeResult): void {
    this.responses.push(response);
  }

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    this.calls.push({
      command: command.command,
      args: [...command.args],
      options,
    });
    const response = this.responses.shift();
    if (!response) {
      throw new Error(
        `FakeRunner response missing for command: ${command.command} ${command.args.join(" ")}`,
      );
    }
    return response;
  }
}

class FakeCleanup implements LifecycleCleanup {
  readonly calls: CleanupCall[] = [];

  add(name: string, run: () => Promise<void> | void): void {
    this.calls.push({ name, run });
  }
}

function instance(overrides: Partial<NemoClawInstance> = {}): NemoClawInstance {
  return {
    onboarding: "cloud-openclaw",
    sandboxName: "e2e-cloud-oc",
    agent: "openclaw",
    provider: "nvidia",
    providerEnv: "cloud",
    gatewayUrl: "http://127.0.0.1:18789",
    result: shellResult(0),
    ...overrides,
  };
}

function fixture(
  runner: FakeRunner,
  cleanup: FakeCleanup,
  runtimeEnvironment?: NodeJS.ProcessEnv,
): LifecyclePhaseFixture {
  const host = new HostCliClient(runner);
  const sandbox = new SandboxClient(runner);
  const runtimeProvider = new RuntimeProviderPrerequisite(
    host,
    (reason) => {
      throw new Error(reason);
    },
    runtimeEnvironment,
  );
  return new LifecyclePhaseFixture(host, sandbox, cleanup, undefined, runtimeProvider);
}

function restoreEnv(name: string, value: string | undefined): void {
  Reflect.deleteProperty(process.env, name);
  Object.assign(process.env, value === undefined ? {} : { [name]: value });
}

describe("LifecyclePhaseFixture.trackInstallerGatewayUserService", () => {
  let root: string, config: string, unit: string;
  let previousConfig: string | undefined, previousPath: string | undefined;
  let runner: FakeRunner, cleanup: FakeCleanup;
  const marker = "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-installer-service-cleanup-"));
    config = path.join(root, "config");
    unit = path.join(config, "systemd", "user", "nemoclaw-openshell-gateway.service");
    previousConfig = process.env.XDG_CONFIG_HOME;
    previousPath = process.env.PATH;
    process.env.XDG_CONFIG_HOME = config;
    process.env.PATH = `${root}:${previousPath ?? ""}`;
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(path.join(root, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runner = new FakeRunner();
    cleanup = new FakeCleanup();
    runner.run = async (command, options) => {
      runner.calls.push({ command: command.command, args: [...command.args], options });
      const result = spawnSync(command.command, ["-c", command.args[1]!], {
        env: options?.env,
        encoding: "utf8",
        timeout: 10_000,
      });
      return shellResult(result.status ?? 1, `${result.stdout ?? ""}${result.stderr ?? ""}`);
    };
  });

  afterEach(() => {
    restoreEnv("XDG_CONFIG_HOME", previousConfig);
    restoreEnv("PATH", previousPath);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("removes a newly installed service last using the captured environment", async () => {
    fixture(runner, cleanup).trackInstallerGatewayUserService();
    expect(runner.calls).toHaveLength(0);
    expect(cleanup.calls).toHaveLength(1);
    fs.writeFileSync(unit, marker);
    process.env.XDG_CONFIG_HOME = path.join(root, "changed-config");
    cleanup.add("sandbox", () => {
      expect(fs.existsSync(unit)).toBe(true);
    });
    await cleanup.calls[1]!.run();
    await cleanup.calls[0]!.run();
    expect(fs.existsSync(unit)).toBe(false);
    expect(runner.calls[0]?.options?.env?.XDG_CONFIG_HOME).toBe(config);
  });

  it.each([
    ["file", () => fs.writeFileSync(unit, marker)],
    ["directory", () => fs.mkdirSync(unit)],
    ["dangling symlink", () => fs.symlinkSync("missing", unit)],
  ] as const)("preserves a preexisting %s", (_kind, create) => {
    create();
    fixture(runner, cleanup).trackInstallerGatewayUserService();
    expect(cleanup.calls).toHaveLength(0);
    expect(fs.lstatSync(unit)).toBeTruthy();
  });

  it("refuses a foreign replacement during deferred cleanup", async () => {
    fixture(runner, cleanup).trackInstallerGatewayUserService();
    fs.writeFileSync(unit, "foreign");
    await expect(cleanup.calls[0]!.run()).rejects.toThrow(/Refusing to remove foreign/);
    expect(fs.readFileSync(unit, "utf8")).toBe("foreign");
  });

  it("propagates inspection errors other than absence", () => {
    fs.rmSync(config, { recursive: true });
    fs.writeFileSync(config, "foreign");
    expect(() => fixture(runner, cleanup).trackInstallerGatewayUserService()).toThrow(/ENOTDIR/);
    expect(cleanup.calls).toHaveLength(0);
  });
});

describe("LifecyclePhaseFixture rebuild helpers", () => {
  it("accepts ANSI-colored Ready output when waiting after rebuild", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "NAME  PHASE\ne2e-x  \u001b[32mReady\u001b[39m\n"));
    const cleanup = new FakeCleanup();

    const result = await fixture(runner, cleanup).assertSandboxReadyAfterRebuild("e2e-x", {
      attempts: 1,
      delayMs: 0,
    });

    expect(result.stdout).toContain("Ready");
    expect(runner.calls[0]).toMatchObject({
      command: "openshell",
      args: ["sandbox", "list"],
    });
  });

  it("requires an exact sandbox-name match when waiting after rebuild", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "NAME  PHASE\ne2e-x-dev  Ready\n"));
    runner.enqueue(shellResult(0, "NAME  PHASE\ne2e-x  Ready\n"));
    const cleanup = new FakeCleanup();

    const result = await fixture(runner, cleanup).assertSandboxReadyAfterRebuild("e2e-x", {
      attempts: 2,
      delayMs: 0,
    });

    expect(result.stdout).toContain("e2e-x  Ready");
    expect(runner.calls).toHaveLength(2);
  });

  it("waits for Ready before checking a sandbox after gateway restart", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "NAME  PHASE\ne2e-x  Provisioning\n"));
    runner.enqueue(shellResult(0, "NAME  PHASE\ne2e-x  Ready\n"));
    const cleanup = new FakeCleanup();

    const result = await fixture(runner, cleanup).waitForSandboxReadyAfterGatewayRestart("e2e-x", {
      attempts: 2,
      delayMs: 0,
    });

    expect(result.stdout).toContain("e2e-x  Ready");
    expect(runner.calls).toHaveLength(2);
  });
});

describe("LifecyclePhaseFixture gateway runtime restart helpers", () => {
  it("falls back to PID/container controls when the selected user service is inactive (#10947)", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "12345\n")); // resolveHostRuntime pid probe
    runner.enqueue(shellResult(0)); // forward stop
    runner.enqueue(shellResult(75)); // selected user service is inactive
    runner.enqueue(shellResult(0)); // pid stop
    runner.enqueue(shellResult(0)); // container stop
    runner.enqueue(shellResult(1, "")); // expectHostRuntimeStopped pid probe
    runner.enqueue(shellResult(0, "")); // expectHostRuntimeStopped container probe
    runner.enqueue(shellResult(0)); // lifecycle-gateway-stopped true artifact
    runner.enqueue(shellResult(0, "gateway started\n")); // start the registered gateway through its existing startup owner
    runner.enqueue(shellResult(0, "Connected to nemoclaw\n")); // waitForGatewayConnected
    const cleanup = new FakeCleanup();
    const host = new HostCliClient(runner);
    const sandbox = new SandboxClient(runner);
    const fx = new LifecyclePhaseFixture(host, sandbox, cleanup, new GatewayClient(host, sandbox));

    await expect(fx.restartGatewayRuntime({ delayMs: 0, sandboxName: "e2e-x" })).resolves.toEqual({
      kind: "pid",
      id: "12345",
    });
    await fx.waitForGatewayConnected({ attempts: 1, intervalMs: 1 });

    expect(runner.calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      expect.stringContaining("sh -lc pid_file="),
      "sh -lc command -v openshell >/dev/null 2>&1 && openshell forward stop 18789 || true",
      expect.stringContaining("bash -c set -eu"),
      expect.stringContaining("sh -lc pid_file="),
      "docker container ps --format {{.ID}}\t{{.Names}}",
      expect.stringContaining("sh -lc pid_file="),
      "docker container ps --format {{.ID}}\t{{.Names}}",
      "true ",
      `${process.execPath} -e ${buildGatewayRuntimeStartScript()} e2e-x`,
      "openshell status",
    ]);
  });

  it("captures the OpenShell gateway user service status and journal when gateway health never recovers", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(1, "Connection refused")); // openshell status
    runner.enqueue(shellResult(0, "ActiveState=failed\nResult=exit-code\n")); // diagnostics
    const cleanup = new FakeCleanup();
    const fx = fixture(runner, cleanup);

    await expect(fx.waitForGatewayConnected({ attempts: 1, intervalMs: 1 })).rejects.toThrow(
      /service diagnostics: \/tmp\/result\.json/,
    );

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]).toMatchObject({
      command: "sh",
      options: {
        artifactName: "lifecycle-gateway-user-service-diagnostics",
      },
    });
    expect(runner.calls[1]?.args[1]).toContain(
      'journalctl --user --unit "$service" --no-pager --lines=200',
    );
  });

  it("stops only the exact gateway container when a sandbox has the gateway-name prefix", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0)); // forward stop
    runner.enqueue(shellResult(0, "NEMOCLAW_E2E_STOPPED_GATEWAY_USER_SERVICE=unavailable\n"));
    runner.enqueue(shellResult(0)); // pid stop
    runner.enqueue(shellResult(0, "gateway-id\topenshell-cluster-nemoclaw\n")); // discover
    runner.enqueue(shellResult(0)); // container stop

    await fixture(runner, new FakeCleanup()).stopGatewayRuntime();

    const containerStop = runner.calls.find(
      (call) => call.options?.artifactName === "lifecycle-gateway-container-stop",
    );
    expect(containerStop?.command).toBe("docker");
    expect(containerStop?.args).toEqual(["container", "stop", "gateway-id"]);
    const discovery = runner.calls.find(
      (call) => call.options?.artifactName === "lifecycle-gateway-runtime-discover",
    );
    expect(discovery?.args).toEqual(["container", "ps", "--format", "{{.ID}}\t{{.Names}}"]);
  });

  it("stops a supported user service without invoking legacy runtime controls (#10947)", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0)); // forward stop
    runner.enqueue(shellResult(0, stoppedGatewayUserService)); // user service stop

    await fixture(runner, new FakeCleanup()).stopGatewayRuntime();

    expect(runner.calls.map((call) => call.options?.artifactName)).toEqual([
      "lifecycle-gateway-forward-stop",
      "lifecycle-gateway-user-service-stop",
    ]);
  });

  it.each(["homebrew:homebrew.mxcl.openshell", "homebrew:sh.brew.openshell"])(
    "passes the exact Homebrew user-service selection to restart: %s (#10947)",
    async (selection) => {
      const runner = new FakeRunner();
      const cleanup = new FakeCleanup();
      runner.enqueue(shellResult(0)); // forward stop
      runner.enqueue(shellResult(0, `NEMOCLAW_E2E_STOPPED_GATEWAY_USER_SERVICE=${selection}\n`)); // user service stop
      const fx = fixture(runner, cleanup);

      await fx.stopGatewayRuntime();

      expect(cleanup.calls.map((call) => call.name)).toEqual([
        `lifecycle.gateway-user-service-restart:${selection}`,
      ]);
      runner.enqueue(shellResult(0)); // selected user service restart
      await cleanup.calls[0]!.run();
      const restart = runner.calls.find(
        (call) => call.options?.artifactName === "lifecycle-gateway-user-service-restart",
      );
      expect(restart?.args.at(-1)).toBe(selection);
    },
  );

  it("preserves a pending user-service restart when a repeated stop finds it inactive (#10947)", async () => {
    const runner = new FakeRunner();
    const cleanup = new FakeCleanup();
    const fx = fixture(runner, cleanup);
    runner.enqueue(shellResult(0)); // first forward stop
    runner.enqueue(shellResult(0, stoppedGatewayUserService)); // first user service stop
    runner.enqueue(shellResult(0)); // repeated forward stop
    runner.enqueue(shellResult(75)); // stopped service is inactive

    await fx.stopGatewayRuntime();
    await fx.stopGatewayRuntime();

    expect(cleanup.calls.map((call) => call.name)).toEqual([
      "lifecycle.gateway-user-service-restart:systemd:nemoclaw-openshell-gateway.service",
    ]);
    expect(runner.calls).toHaveLength(4);
    runner.enqueue(shellResult(0)); // pending user service restart
    await cleanup.calls[0]!.run();
    expect(runner.calls.at(-1)?.args.at(-1)).toBe("systemd:nemoclaw-openshell-gateway.service");
  });

  it("reports a user-service stop failure without invoking legacy controls (#10947)", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0)); // forward stop
    runner.enqueue(shellResult(1, "Failed to connect to bus"));

    await expect(fixture(runner, new FakeCleanup()).stopGatewayRuntime()).rejects.toThrow(
      /user service stop failed.*Failed to connect to bus/,
    );
    expect(runner.calls).toHaveLength(2);
  });

  it("reports a failed gateway restart before waiting for health", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0)); // forward stop
    runner.enqueue(shellResult(75)); // no selected user service
    runner.enqueue(shellResult(0)); // pid stop
    runner.enqueue(shellResult(0, "")); // no gateway container
    runner.enqueue(shellResult(1, "gateway recovery failed"));
    const fx = fixture(runner, new FakeCleanup());

    await expect(fx.restartGatewayRuntime({ delayMs: 0, sandboxName: "e2e-x" })).rejects.toThrow(
      /restart OpenShell gateway runtime/,
    );
    expect(runner.calls.at(-1)).toMatchObject({
      command: process.execPath,
      args: ["-e", buildGatewayRuntimeStartScript(), "e2e-x"],
    });
    expect(runner.calls).toHaveLength(5);
  });

  it.each([75, 1])(
    "preserves the selected service for cleanup when restart exits %i",
    async (exitCode) => {
      const runner = new FakeRunner();
      const cleanup = new FakeCleanup();
      const fx = fixture(runner, cleanup);
      runner.enqueue(shellResult(0)); // forward stop
      runner.enqueue(shellResult(0, stoppedGatewayUserService));
      runner.enqueue(shellResult(exitCode, "service restart failed"));

      await expect(fx.restartGatewayRuntime({ delayMs: 0, sandboxName: "e2e-x" })).rejects.toThrow(
        /user service.*(?:not available|restart failed)/,
      );
      expect(runner.calls).toHaveLength(3);
      expect(runner.calls.at(-1)?.args.at(-1)).toBe("systemd:nemoclaw-openshell-gateway.service");
      expect(cleanup.calls).toHaveLength(1);

      runner.enqueue(shellResult(0));
      await cleanup.calls[0]!.run();
      expect(runner.calls.at(-1)?.args.at(-1)).toBe("systemd:nemoclaw-openshell-gateway.service");
      expect(runner.calls).toHaveLength(4);
      await cleanup.calls[0]!.run();
      expect(runner.calls).toHaveLength(4);
    },
  );

  it("rejects gateway recovery without a selected service or registered sandbox name", async () => {
    const runner = new FakeRunner();
    await expect(fixture(runner, new FakeCleanup()).startGatewayRuntime()).rejects.toThrow(
      /registered sandbox name/,
    );
    expect(runner.calls).toHaveLength(0);
  });

  it.each([undefined, "", " "])(
    "rejects missing restart identity before stopping any runtime: %s",
    async (sandboxName) => {
      const runner = new FakeRunner();
      const cleanup = new FakeCleanup();
      await expect(
        fixture(runner, cleanup).restartGatewayRuntime({ sandboxName, delayMs: 0 }),
      ).rejects.toThrow(/sandbox name or a required user service/);
      expect(runner.calls).toHaveLength(0);
      expect(cleanup.calls).toHaveLength(0);
    },
  );

  it("requires the selected user service when the lifecycle requests it", async () => {
    const runner = new FakeRunner();
    const fx = fixture(runner, new FakeCleanup());

    await expect(fx.startGatewayRuntime({ requireUserService: true })).rejects.toThrow(
      /user service is not available/,
    );
    expect(runner.calls).toHaveLength(0);
  });

  it("starts the registered gateway through its startup owner when no service was stopped", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "gateway started\n"));

    await expect(
      fixture(runner, new FakeCleanup()).startGatewayRuntime({ sandboxName: "e2e-x" }),
    ).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(runner.calls).toEqual([
      expect.objectContaining({
        command: process.execPath,
        args: ["-e", buildGatewayRuntimeStartScript(), "e2e-x"],
      }),
    ]);
  });
});

describe("LifecyclePhaseFixture profile dispatch", () => {
  it("rejects unknown lifecycle profiles", async () => {
    const runner = new FakeRunner();
    const cleanup = new FakeCleanup();

    await expect(
      // @ts-expect-error — exhaustiveness check
      fixture(runner, cleanup).simulate("not-a-profile", instance()),
    ).rejects.toThrow(/Unsupported lifecycle profile/);
  });

  it("exposes the lifecycle phase on the E2E target context", () => {
    expectTypeOf<E2ETargetFixtures["lifecycle"]>().toEqualTypeOf<LifecyclePhaseFixture>();
  });
});

describe("LifecyclePhaseFixture DCode invalid-credential rebuild", () => {
  const sandboxName = "e2e-dcode-cloud";
  const validCredential = "valid-fixture-credential";
  const options = dcodeInvalidCredentialRebuildOptionsFromRegistryEntry(
    {
      agent: "langchain-deepagents-code",
      gatewayName: "nemoclaw",
      provider: "compatible-endpoint",
      model: "nvidia/nvidia/nemotron-3-ultra",
    },
    validCredential,
  );

  function dcodeInstance(): NemoClawInstance {
    return instance({
      onboarding: "cloud-langchain-deepagents-code",
      sandboxName,
      agent: "langchain-deepagents-code",
    });
  }

  function enqueuePreamble(runner: FakeRunner): void {
    runner.enqueue(shellResult(0, `${sandboxName}\n`));
    runner.enqueue(shellResult(0, `NAME PHASE\n${sandboxName} Ready\n`));
    runner.enqueue(shellResult(0)); // marker write
    runner.enqueue(shellResult(0, "container-a\ncontainer-b\n"));
    runner.enqueue(shellResult(0, "200"));
  }

  it.each([
    [
      "Docker",
      { NEMOCLAW_GATEWAY_RUNTIME: "docker" },
      "docker",
      ["ps"],
      "label=openshell.ai/managed-by=openshell",
    ],
    [
      "Podman",
      {
        HOME: "/home/runner",
        PATH: "/usr/bin",
        NEMOCLAW_GATEWAY_RUNTIME: "podman",
        OPENSHELL_PODMAN_SOCKET: "/run/user/1001/podman/podman.sock",
        XDG_RUNTIME_DIR: "/run/user/1001",
      },
      "podman",
      ["--url", "unix:///run/user/1001/podman/podman.sock", "ps"],
      "label=openshell.managed=true",
    ],
  ] as const)(
    "proves 2xx→401→rejected rebuild without mutation through %s, then restores 2xx",
    async (_displayName, runtimeEnvironment, runtimeCommand, runtimeArgsPrefix, managedLabel) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-lifecycle-home-"));
      const previousHome = process.env.HOME;
      process.env.HOME = home;
      try {
        const runner = new FakeRunner();
        enqueuePreamble(runner);
        runner.enqueue(shellResult(0)); // install invalid provider credential
        runner.enqueue(shellResult(0, "401"));
        runner.enqueue(shellResult(0, `NAME PHASE\n${sandboxName} Ready\n`));
        runner.enqueue(
          shellResult(
            1,
            "Rebuild preflight failed: recorded inference credentials or route were rejected.\n" +
              "existing sandbox inference probe returned HTTP 401\n" +
              "Sandbox is untouched — no data was lost.\n",
          ),
        );
        runner.enqueue(shellResult(0, "container-b\ncontainer-a\n"));
        runner.enqueue(shellResult(0, "NEMOCLAW_DCODE_INVALID_CREDENTIAL_REBUILD_MARKER"));
        runner.enqueue(shellResult(0, `NAME PHASE\n${sandboxName} Ready\n`));
        runner.enqueue(shellResult(0)); // restore valid provider credential
        runner.enqueue(shellResult(0, "200"));
        const cleanup = new FakeCleanup();

        const result = await fixture(runner, cleanup, runtimeEnvironment).simulate(
          "dcode-rebuild-invalid-credential",
          dcodeInstance(),
          options,
        );

        expect(result.profile).toBe("dcode-rebuild-invalid-credential");
        expect(result.steps.map((step) => step.id)).toEqual(
          expect.arrayContaining([
            "inference-route:baseline",
            "inference-route:invalid",
            "nemoclaw-rebuild:invalid-credential",
            "container-ids:after",
            "marker-read:after",
            "sandbox-ready:after",
            "inference-route:restored",
          ]),
        );
        const providerUpdates = runner.calls.filter(
          (call) =>
            call.command === "openshell" && call.args.slice(0, 2).join(" ") === "provider update",
        );
        expect(providerUpdates).toHaveLength(2);
        const invalidCredential = providerUpdates[0].options?.env?.COMPATIBLE_API_KEY;
        expect(invalidCredential).toMatch(/^nvapi-e2e-invalid-/);
        expect(providerUpdates[0].args).not.toContain(invalidCredential);
        expect(providerUpdates[0].options?.redactionValues).toContain(invalidCredential);
        expect(providerUpdates[1].options?.env?.COMPATIBLE_API_KEY).toBe(validCredential);
        const rebuild = runner.calls.find(
          (call) => call.command === "nemoclaw" && call.args.includes("rebuild"),
        );
        expect(rebuild?.options?.env).not.toHaveProperty("COMPATIBLE_API_KEY");
        const containerIds = runner.calls.find(
          (call) => call.options?.artifactName === "lifecycle-dcode-container-ids-before",
        );
        expect(containerIds?.command).toBe(runtimeCommand);
        expect(containerIds?.args).toEqual([
          ...runtimeArgsPrefix,
          "-a",
          "--no-trunc",
          "--filter",
          managedLabel,
          "--filter",
          `label=openshell.ai/sandbox-name=${sandboxName}`,
          "--format",
          "{{.ID}}",
        ]);
        expect(cleanup.calls).toHaveLength(1);

        const callCount = runner.calls.length;
        await cleanup.calls[0].run();
        expect(runner.calls).toHaveLength(callCount);
      } finally {
        restoreEnv("HOME", previousHome);
        fs.rmSync(home, { force: true, recursive: true });
      }
    },
  );

  it("refuses to rotate a gateway provider shared by another sandbox", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, `${sandboxName}\nother-sandbox\n`));
    const cleanup = new FakeCleanup();

    await expect(
      fixture(runner, cleanup).simulate(
        "dcode-rebuild-invalid-credential",
        dcodeInstance(),
        options,
      ),
    ).rejects.toThrow(/gateway's only sandbox/);
    expect(runner.calls).toHaveLength(1);
    expect(cleanup.calls).toHaveLength(0);
  });

  it("preserves both the primary failure and a credential restoration failure", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-lifecycle-errors-home-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const runner = new FakeRunner();
      enqueuePreamble(runner);
      runner.enqueue(shellResult(1, "invalid provider update failed"));
      runner.enqueue(shellResult(1, "valid provider restoration failed"));
      const cleanup = new FakeCleanup();

      const failure = await fixture(runner, cleanup)
        .simulate("dcode-rebuild-invalid-credential", dcodeInstance(), options)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toHaveLength(2);
      expect(String((failure as AggregateError).errors[0])).toContain(
        "invalid provider update failed",
      );
      expect(String((failure as AggregateError).errors[1])).toContain(
        "valid provider restoration failed",
      );
      expect(cleanup.calls).toHaveLength(1);
    } finally {
      restoreEnv("HOME", previousHome);
      fs.rmSync(home, { force: true, recursive: true });
    }
  });

  it("derives only the expected DCode compatible-endpoint binding", () => {
    expect(options).toEqual({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      credentialEnv: "COMPATIBLE_API_KEY",
      model: "nvidia/nvidia/nemotron-3-ultra",
      validCredential,
    });
    expect(() =>
      dcodeInvalidCredentialRebuildOptionsFromRegistryEntry(
        {
          agent: "openclaw",
          gatewayName: "nemoclaw",
          provider: "compatible-endpoint",
          model: "nvidia/model",
        },
        validCredential,
      ),
    ).toThrow(/registry agent/);
  });
});
