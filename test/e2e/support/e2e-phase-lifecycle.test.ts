// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  type CommandRunner,
  GatewayClient,
  HostCliClient,
  SandboxClient,
} from "../fixtures/clients/index.ts";
import type { E2ETargetFixtures } from "../fixtures/e2e-test.ts";
import type { NemoClawInstance } from "../fixtures/phases/index.ts";
import {
  buildBackupContainerName,
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

function fixture(runner: FakeRunner, cleanup: FakeCleanup): LifecyclePhaseFixture {
  const host = new HostCliClient(runner);
  const sandbox = new SandboxClient(runner);
  return new LifecyclePhaseFixture(host, sandbox, cleanup);
}

async function preparedPostRebootFixture(
  runner: FakeRunner,
  cleanup: FakeCleanup,
  stage: "upstream" | "existing" | "staged" = "existing",
): Promise<LifecyclePhaseFixture> {
  runner.enqueue(shellResult(0)); // openshell-gateway available
  runner.enqueue(shellResult(0, `NEMOCLAW_E2E_GATEWAY_USER_SERVICE=${stage}\n`));
  const prepared = fixture(runner, cleanup);
  await prepared.preparePostReboot();
  return prepared;
}

function restoreEnv(name: string, value: string | undefined): void {
  Reflect.deleteProperty(process.env, name);
  Object.assign(process.env, value === undefined ? {} : { [name]: value });
}

describe("LifecyclePhaseFixture.preparePostReboot", () => {
  it("installs OpenShell and stages the gateway user service when openshell-gateway is unavailable", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(1)); // openshell-gateway unavailable
    runner.enqueue(shellResult(0)); // install OpenShell
    runner.enqueue(shellResult(0, "NEMOCLAW_E2E_GATEWAY_USER_SERVICE=staged\n"));
    const cleanup = new FakeCleanup();

    const result = await fixture(runner, cleanup).preparePostReboot();

    expect(result).toBe("staged");
    expect(runner.calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      expect.stringContaining('bash -lc command -v "$1"'),
      expect.stringContaining("bash "),
      expect.stringContaining("bash -lc set -eu"),
    ]);
    expect(runner.calls[1]?.options?.artifactName).toBe("lifecycle-prereq-install-openshell");
    expect(cleanup.calls.map((call) => call.name)).toEqual([
      "lifecycle.remove-staged-gateway-user-service",
    ]);
  });

  it("rejects post-reboot simulation that was not prepared before onboarding", async () => {
    await expect(
      fixture(new FakeRunner(), new FakeCleanup()).simulate("post-reboot-recovery", instance()),
    ).rejects.toThrow(/must be prepared before post-reboot onboarding/);
  });
});

describe("LifecyclePhaseFixture.simulate post-reboot-recovery (stop-original)", () => {
  it("stops the labeled container, restarts the gateway service, then runs status", async () => {
    const runner = new FakeRunner();
    const cleanup = new FakeCleanup();
    const prepared = await preparedPostRebootFixture(runner, cleanup, "staged");
    runner.enqueue(shellResult(0, "openshell-cluster-e2e-cloud-oc\n")); // discover
    runner.enqueue(shellResult(0)); // docker stop
    runner.enqueue(shellResult(0)); // forward stop
    runner.enqueue(shellResult(0)); // gateway stop
    runner.enqueue(shellResult(0)); // pid stop
    runner.enqueue(shellResult(0, "gateway-id\topenshell-cluster-nemoclaw\n")); // discover
    runner.enqueue(shellResult(0)); // container stop
    runner.enqueue(shellResult(0)); // user service restart
    runner.enqueue(shellResult(0, "Connected to nemoclaw\n")); // openshell status
    runner.enqueue(shellResult(0)); // boot-owned docker start
    runner.enqueue(shellResult(0, "NAME  PHASE\ne2e-cloud-oc  Ready\n"));
    runner.enqueue(shellResult(0)); // status proves recovered delivery readiness

    const result = await prepared.simulate("post-reboot-recovery", instance());

    expect(result.profile).toBe("post-reboot-recovery");
    expect(result.steps.map((step) => step.id)).toEqual([
      "runtime-stop:openshell-cluster-e2e-cloud-oc",
      "gateway-restart:user-service",
      "gateway-connected:nemoclaw",
      "runtime-boot-start:openshell-cluster-e2e-cloud-oc",
      "sandbox-ready-after-boot:e2e-cloud-oc",
      "nemoclaw-status:e2e-cloud-oc",
    ]);
    expect(runner.calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      expect.stringContaining('bash -lc command -v "$1"'),
      expect.stringContaining("bash -lc set -eu"),
      "docker container ps --all --filter label=openshell.ai/sandbox-name=e2e-cloud-oc --format {{.Names}}",
      "docker container stop openshell-cluster-e2e-cloud-oc",
      "sh -lc command -v openshell >/dev/null 2>&1 && openshell forward stop 18789 || true",
      "sh -lc command -v openshell >/dev/null 2>&1 && openshell gateway stop -g nemoclaw || true",
      expect.stringContaining("sh -lc pid_file="),
      "docker container ps --format {{.ID}}\t{{.Names}}",
      "docker container stop gateway-id",
      expect.stringContaining('systemctl --user cat "$service"'),
      "openshell status",
      "docker container start openshell-cluster-e2e-cloud-oc",
      "openshell sandbox list",
      "nemoclaw e2e-cloud-oc status",
    ]);
    expect(cleanup.calls.map((call) => call.name)).toEqual([
      "lifecycle.remove-staged-gateway-user-service",
      "lifecycle.runtime-start:openshell-cluster-e2e-cloud-oc",
    ]);
  });

  it("fails when status cannot prove post-reboot recovery", async () => {
    const runner = new FakeRunner();
    const cleanup = new FakeCleanup();
    const prepared = await preparedPostRebootFixture(runner, cleanup);
    runner.enqueue(shellResult(0, "container-1\n")); // discover
    runner.enqueue(shellResult(0)); // docker stop
    runner.enqueue(shellResult(0)); // forward stop
    runner.enqueue(shellResult(0)); // gateway stop
    runner.enqueue(shellResult(0)); // pid stop
    runner.enqueue(shellResult(0)); // container stop
    runner.enqueue(shellResult(0)); // user service restart
    runner.enqueue(shellResult(0, "Connected to nemoclaw\n")); // openshell status
    runner.enqueue(shellResult(0)); // boot-owned docker start
    runner.enqueue(shellResult(0, "NAME  PHASE\ne2e-cloud-oc  Ready\n"));
    runner.enqueue(shellResult(1, "Removed stale local registry entry.\n")); // status non-zero

    await expect(prepared.simulate("post-reboot-recovery", instance())).rejects.toThrow(
      /nemoclaw e2e-cloud-oc status failed: Removed stale local registry entry/,
    );
  });

  it("models the boot-owned container restart before checking status", async () => {
    const runner = new FakeRunner();
    const cleanup = new FakeCleanup();
    const prepared = await preparedPostRebootFixture(runner, cleanup);
    runner.enqueue(shellResult(0, "container-1\n")); // discover
    runner.enqueue(shellResult(0)); // docker stop
    runner.enqueue(shellResult(0)); // forward stop
    runner.enqueue(shellResult(0)); // gateway stop
    runner.enqueue(shellResult(0)); // pid stop
    runner.enqueue(shellResult(0)); // container stop
    runner.enqueue(shellResult(0)); // user service restart
    runner.enqueue(shellResult(0, "Connected to nemoclaw\n")); // openshell status
    runner.enqueue(shellResult(0)); // boot-owned docker start
    runner.enqueue(shellResult(0, "NAME  PHASE\ne2e-cloud-oc  Ready\n"));
    runner.enqueue(shellResult(0)); // status restores the delivery chain

    const result = await prepared.simulate("post-reboot-recovery", instance());

    expect(
      runner.calls
        .map((call) => `${call.command} ${call.args.join(" ")}`)
        .filter(
          (call) =>
            call === "docker container start container-1" ||
            call === "openshell sandbox list" ||
            call === "nemoclaw e2e-cloud-oc status",
        ),
    ).toEqual([
      "docker container start container-1",
      "openshell sandbox list",
      "nemoclaw e2e-cloud-oc status",
    ]);
    expect(result.steps.slice(-3).map((step) => step.id)).toEqual([
      "runtime-boot-start:container-1",
      "sandbox-ready-after-boot:e2e-cloud-oc",
      "nemoclaw-status:e2e-cloud-oc",
    ]);
    expect(result.steps.at(-1)?.results[0]?.exitCode).toBe(0);
  });

  it("fails when no managed runtime resource carries the OpenShell sandbox-name label", async () => {
    const runner = new FakeRunner();
    const cleanup = new FakeCleanup();
    const prepared = await preparedPostRebootFixture(runner, cleanup);
    runner.enqueue(shellResult(0, "\n")); // discover returns nothing

    await expect(prepared.simulate("post-reboot-recovery", instance())).rejects.toThrow(
      /expected at least one managed runtime resource labeled/,
    );
  });

  it("fails when selected-runtime discovery returns non-zero", async () => {
    const runner = new FakeRunner();
    const cleanup = new FakeCleanup();
    const prepared = await preparedPostRebootFixture(runner, cleanup);
    runner.enqueue(shellResult(1, "Cannot connect to the Docker daemon"));

    await expect(prepared.simulate("post-reboot-recovery", instance())).rejects.toThrow(
      /could not query the selected runtime provider for label/,
    );
  });

  it("fails when the managed OpenShell gateway user service is unavailable", async () => {
    const runner = new FakeRunner();
    const cleanup = new FakeCleanup();
    const prepared = await preparedPostRebootFixture(runner, cleanup);
    runner.enqueue(shellResult(0, "container-1\n")); // discover
    runner.enqueue(shellResult(0)); // docker stop
    runner.enqueue(shellResult(0)); // forward stop
    runner.enqueue(shellResult(0)); // gateway stop
    runner.enqueue(shellResult(0)); // pid stop
    runner.enqueue(shellResult(0)); // container stop
    runner.enqueue(shellResult(75, "")); // no managed user service available

    await expect(prepared.simulate("post-reboot-recovery", instance())).rejects.toThrow(
      /OpenShell gateway user service is not available/,
    );

    expect(runner.calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual(
      expect.arrayContaining([expect.stringContaining('systemctl --user cat "$service"')]),
    );
  });
});

describe("LifecyclePhaseFixture.simulate post-reboot-recovery (rename-to-gpu-backup)", () => {
  it("stops, then renames the labeled container to a *-nemoclaw-gpu-backup-* sibling", async () => {
    const runner = new FakeRunner();
    const cleanup = new FakeCleanup();
    const prepared = await preparedPostRebootFixture(runner, cleanup);
    runner.enqueue(shellResult(0, "openshell-cluster-e2e-x\n")); // discover
    runner.enqueue(shellResult(0)); // docker stop
    runner.enqueue(shellResult(0)); // docker rename
    runner.enqueue(shellResult(0)); // forward stop
    runner.enqueue(shellResult(0)); // gateway stop
    runner.enqueue(shellResult(0)); // pid stop
    runner.enqueue(shellResult(0)); // container stop
    runner.enqueue(shellResult(0)); // user service restart
    runner.enqueue(shellResult(0, "Connected to nemoclaw\n")); // openshell status
    runner.enqueue(shellResult(0)); // boot-owned docker start
    runner.enqueue(shellResult(0, "NAME  PHASE\ne2e-x  Ready\n"));
    runner.enqueue(shellResult(0)); // status proves recovered delivery readiness

    const result = await prepared.simulate(
      "post-reboot-recovery",
      instance({ sandboxName: "e2e-x" }),
      { mode: "rename-to-gpu-backup" },
    );

    expect(result.steps.map((step) => step.id.split("->")[0])).toContain(
      "runtime-rename:openshell-cluster-e2e-x",
    );
    const renameCall = runner.calls.find(
      (call) => call.command === "docker" && call.args.slice(0, 2).join(" ") === "container rename",
    );
    expect(renameCall).toBeTruthy();
    expect(renameCall!.args[2]).toBe("openshell-cluster-e2e-x");
    expect(renameCall!.args[3]).toMatch(/^openshell-cluster-e2e-x-nemoclaw-gpu-backup-\d+$/);
    expect(runner.calls).toContainEqual(
      expect.objectContaining({
        command: "docker",
        args: ["container", "start", renameCall!.args[3]],
      }),
    );

    // Cleanup queue now has both docker-start and docker-rename-back.
    expect(cleanup.calls.map((call) => call.name.split(":")[0])).toEqual([
      "lifecycle.runtime-start",
      "lifecycle.runtime-rename-back",
    ]);
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

    const result = await fixture(runner, cleanup).assertSandboxReadyAfterGatewayRestart("e2e-x", {
      attempts: 2,
      delayMs: 0,
    });

    expect(result.stdout).toContain("e2e-x  Ready");
    expect(runner.calls).toHaveLength(2);
  });
});

describe("LifecyclePhaseFixture gateway runtime restart helpers", () => {
  it("stops PID/container runtimes, starts the previous runtime shape, and polls health", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "12345\n")); // resolveHostRuntime pid probe
    runner.enqueue(shellResult(0)); // forward stop
    runner.enqueue(shellResult(0)); // gateway stop
    runner.enqueue(shellResult(0)); // pid stop
    runner.enqueue(shellResult(0)); // container stop
    runner.enqueue(shellResult(1, "")); // expectHostRuntimeStopped pid probe
    runner.enqueue(shellResult(0, "")); // expectHostRuntimeStopped container probe
    runner.enqueue(shellResult(0)); // lifecycle-gateway-stopped true artifact
    runner.enqueue(shellResult(75, "")); // no user service available
    runner.enqueue(shellResult(0, "status recovered\n")); // start through nemoclaw status
    runner.enqueue(shellResult(0, "Connected to nemoclaw\n")); // waitForGatewayConnected
    const cleanup = new FakeCleanup();
    const host = new HostCliClient(runner);
    const sandbox = new SandboxClient(runner);
    const fx = new LifecyclePhaseFixture(host, sandbox, cleanup, new GatewayClient(host, sandbox));

    await expect(fx.restartGatewayRuntime({ delayMs: 0 })).resolves.toEqual({
      kind: "pid",
      id: "12345",
    });
    await fx.waitForGatewayConnected({ attempts: 1, intervalMs: 1 });

    expect(runner.calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      expect.stringContaining("sh -lc pid_file="),
      "sh -lc command -v openshell >/dev/null 2>&1 && openshell forward stop 18789 || true",
      "sh -lc command -v openshell >/dev/null 2>&1 && openshell gateway stop -g nemoclaw || true",
      expect.stringContaining("sh -lc pid_file="),
      "docker container ps --format {{.ID}}\t{{.Names}}",
      expect.stringContaining("sh -lc pid_file="),
      "docker container ps --format {{.ID}}\t{{.Names}}",
      "true ",
      expect.stringContaining("sh -lc set -eu"),
      "nemoclaw status",
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
    runner.enqueue(shellResult(0)); // gateway stop
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

  it("can recover a PID runtime through sandbox-specific status", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "status recovered\n"));
    const cleanup = new FakeCleanup();

    await expect(
      fixture(runner, cleanup).startGatewayRuntime(
        { kind: "pid", id: "12345" },
        {
          sandboxName: "e2e-survival",
        },
      ),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(runner.calls.map((call) => `${call.command} ${call.args.join(" ")}`)).toEqual([
      "nemoclaw e2e-survival status",
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

  it("proves 2xx→401→rejected rebuild without mutation, then restores 2xx", async () => {
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

      const result = await fixture(runner, cleanup).simulate(
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
      expect(cleanup.calls).toHaveLength(1);

      const callCount = runner.calls.length;
      await cleanup.calls[0].run();
      expect(runner.calls).toHaveLength(callCount);
    } finally {
      restoreEnv("HOME", previousHome);
      fs.rmSync(home, { force: true, recursive: true });
    }
  });

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

describe("buildBackupContainerName", () => {
  it("appends -nemoclaw-gpu-backup-<ts> to the original name", () => {
    expect(buildBackupContainerName("openshell-cluster-foo", 1717280000000)).toBe(
      "openshell-cluster-foo-nemoclaw-gpu-backup-1717280000000",
    );
  });

  it("truncates the original name to fit within Docker's 253-char limit", () => {
    const longName = "a".repeat(253);
    const result = buildBackupContainerName(longName, 1717280000000);
    expect(result.length).toBeLessThanOrEqual(253);
    expect(result.endsWith("-nemoclaw-gpu-backup-1717280000000")).toBe(true);
  });
});
