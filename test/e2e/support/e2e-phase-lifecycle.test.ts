// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import { restoreEnv } from "../../helpers/env-test-helpers.ts";

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
    sandboxName: "e2e-ubuntu-repo-cloud-openclaw",
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

describe("LifecyclePhaseFixture.simulate post-reboot-recovery (stop-original)", () => {
  it("stops the labeled container then runs `nemoclaw <name> status`", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "openshell-cluster-e2e-ubuntu-repo-cloud-openclaw\n")); // discover
    runner.enqueue(shellResult(0)); // docker stop
    runner.enqueue(shellResult(1, "Removed stale local registry entry.\n")); // status (non-zero on unfixed)
    const cleanup = new FakeCleanup();

    const result = await fixture(runner, cleanup).simulate("post-reboot-recovery", instance());

    expect(result.profile).toBe("post-reboot-recovery");
    expect(result.steps.map((step) => step.id)).toEqual([
      "docker-stop:openshell-cluster-e2e-ubuntu-repo-cloud-openclaw",
      "nemoclaw-status:e2e-ubuntu-repo-cloud-openclaw",
    ]);
    expect(runner.calls.map((call) => ({ command: call.command, args: call.args }))).toEqual([
      {
        command: "docker",
        args: [
          "ps",
          "-a",
          "--filter",
          "label=openshell.ai/sandbox-name=e2e-ubuntu-repo-cloud-openclaw",
          "--format",
          "{{.Names}}",
        ],
      },
      {
        command: "docker",
        args: ["stop", "openshell-cluster-e2e-ubuntu-repo-cloud-openclaw"],
      },
      {
        command: "nemoclaw",
        args: ["e2e-ubuntu-repo-cloud-openclaw", "status"],
      },
    ]);
    expect(cleanup.calls.map((call) => call.name)).toEqual([
      "lifecycle.docker-start:openshell-cluster-e2e-ubuntu-repo-cloud-openclaw",
    ]);
  });

  it("tolerates a non-zero status exit (the bug succeeds at destroying state)", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "container-1\n")); // discover
    runner.enqueue(shellResult(0)); // docker stop
    runner.enqueue(shellResult(1, "Removed stale local registry entry.\n")); // status non-zero
    const cleanup = new FakeCleanup();

    const result = await fixture(runner, cleanup).simulate("post-reboot-recovery", instance());

    // simulate() does not throw; the post-status invariants belong
    // to the state-validation phase that runs after.
    expect(result.steps.find((step) => step.id.startsWith("nemoclaw-status:"))).toBeTruthy();
  });

  it("fails when no Docker container carries the OpenShell sandbox-name label", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "\n")); // discover returns nothing
    const cleanup = new FakeCleanup();

    await expect(
      fixture(runner, cleanup).simulate("post-reboot-recovery", instance()),
    ).rejects.toThrow(/expected at least one Docker container labeled/);
  });

  it("fails when docker discover returns non-zero", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(1, "Cannot connect to the Docker daemon"));
    const cleanup = new FakeCleanup();

    await expect(
      fixture(runner, cleanup).simulate("post-reboot-recovery", instance()),
    ).rejects.toThrow(/could not query Docker for label/);
  });
});

describe("LifecyclePhaseFixture.simulate post-reboot-recovery (rename-to-gpu-backup)", () => {
  it("stops, then renames the labeled container to a *-nemoclaw-gpu-backup-* sibling", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, "openshell-cluster-e2e-x\n")); // discover
    runner.enqueue(shellResult(0)); // docker stop
    runner.enqueue(shellResult(0)); // docker rename
    runner.enqueue(shellResult(1, "Removed stale local registry entry.\n")); // status
    const cleanup = new FakeCleanup();

    const result = await fixture(runner, cleanup).simulate(
      "post-reboot-recovery",
      instance({ sandboxName: "e2e-x" }),
      { mode: "rename-to-gpu-backup" },
    );

    expect(result.steps.map((step) => step.id.split("->")[0])).toContain(
      "docker-rename:openshell-cluster-e2e-x",
    );
    const renameCall = runner.calls.find(
      (call) => call.command === "docker" && call.args[0] === "rename",
    );
    expect(renameCall).toBeTruthy();
    expect(renameCall!.args[1]).toBe("openshell-cluster-e2e-x");
    expect(renameCall!.args[2]).toMatch(/^openshell-cluster-e2e-x-nemoclaw-gpu-backup-\d+$/);

    // Cleanup queue now has both docker-start and docker-rename-back.
    expect(cleanup.calls.map((call) => call.name.split(":")[0])).toEqual([
      "lifecycle.docker-start",
      "lifecycle.docker-rename-back",
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
      expect.stringContaining("sh -lc cid="),
      expect.stringContaining("sh -lc pid_file="),
      "docker ps -qf name=openshell-cluster-nemoclaw",
      "true ",
      "nemoclaw status",
      "openshell status",
    ]);
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
  const sandboxName = "e2e-ubuntu-repo-cloud-langchain-deepagents-code";
  const options = {
    gatewayName: "nemoclaw",
    providerName: "compatible-endpoint",
    credentialEnv: "COMPATIBLE_API_KEY",
    model: "nvidia/nvidia/nemotron-3-ultra",
    validCredential: "valid-fixture-credential",
  } as const;

  function dcodeInstance(): NemoClawInstance {
    return instance({
      onboarding: "cloud-langchain-deepagents-code",
      sandboxName,
      agent: "langchain-deepagents-code",
      // The onboarding shorthand is intentionally not the authoritative
      // gateway provider name used by the lifecycle options.
      provider: "nvidia",
    });
  }

  function enqueueValidatedPreamble(runner: FakeRunner): void {
    runner.enqueue(shellResult(0, `${sandboxName}\n`)); // gateway sandbox names
    runner.enqueue(shellResult(0, `NAME  PHASE\n${sandboxName}  Ready\n`)); // initial Ready
    runner.enqueue(shellResult(0, "compatible-endpoint\n")); // provider names
    runner.enqueue(
      shellResult(0, "Provider: compatible-endpoint\nModel: nvidia/nvidia/nemotron-3-ultra\n"),
    ); // initial route
    runner.enqueue(shellResult(0, "NEMOCLAW_DCODE_IDENTITY_OK\n")); // identity
    runner.enqueue(shellResult(0)); // marker write
    runner.enqueue(shellResult(0, "container-a\ncontainer-b\n")); // Docker IDs before
    runner.enqueue(shellResult(0, "200")); // baseline route
  }

  function enqueueSuccessfulRestoration(runner: FakeRunner): void {
    runner.enqueue(shellResult(0)); // restore provider
    runner.enqueue(shellResult(0, "200")); // restored route
    runner.enqueue(
      shellResult(0, "Provider: compatible-endpoint\nModel: nvidia/nvidia/nemotron-3-ultra\n"),
    ); // restored inference route
    runner.enqueue(shellResult(0, `NAME  PHASE\n${sandboxName}  Ready\n`));
    runner.enqueue(shellResult(0, `Sandbox:\n  Name: ${sandboxName}\n  Phase: Ready\n`));
  }

  function enqueueSuccessfulAtomicProof(runner: FakeRunner): void {
    enqueueValidatedPreamble(runner);
    runner.enqueue(shellResult(0)); // invalid provider update
    runner.enqueue(shellResult(0, "401")); // rejected route
    runner.enqueue(shellResult(0, `NAME  PHASE\n${sandboxName}  Ready\n`)); // Ready under bad key
    runner.enqueue(
      shellResult(
        1,
        "Rebuild preflight failed: recorded inference credentials or route for provider " +
          "'compatible-endpoint' were rejected.\n" +
          "existing sandbox inference probe returned HTTP 401\n" +
          "Sandbox is untouched — no data was lost.\n",
      ),
    ); // rebuild
    runner.enqueue(shellResult(0, "container-b\ncontainer-a\n")); // same IDs, other order
    runner.enqueue(shellResult(0, "NEMOCLAW_DCODE_INVALID_CREDENTIAL_MARKER\n"));
    runner.enqueue(shellResult(0, `NAME  PHASE\n${sandboxName}  Ready\n`));
    enqueueSuccessfulRestoration(runner);
  }

  it("derives gateway runner options from the authoritative registry entry", () => {
    expect(
      dcodeInvalidCredentialRebuildOptionsFromRegistryEntry(
        {
          agent: "langchain-deepagents-code",
          gatewayName: "nemoclaw-8081",
          provider: "compatible-endpoint",
          model: "nvidia/model-from-registry",
        },
        "valid-key",
      ),
    ).toEqual({
      gatewayName: "nemoclaw-8081",
      providerName: "compatible-endpoint",
      credentialEnv: "COMPATIBLE_API_KEY",
      model: "nvidia/model-from-registry",
      validCredential: "valid-key",
    });
  });

  it("rejects incomplete or non-DCode registry entries", () => {
    expect(() =>
      dcodeInvalidCredentialRebuildOptionsFromRegistryEntry(
        {
          agent: "openclaw",
          gatewayName: "nemoclaw",
          provider: "compatible-endpoint",
          credentialEnv: "COMPATIBLE_API_KEY",
          model: "nvidia/model",
        },
        "valid-key",
      ),
    ).toThrow(/langchain-deepagents-code registry entry/);
    expect(() =>
      dcodeInvalidCredentialRebuildOptionsFromRegistryEntry(
        {
          agent: "langchain-deepagents-code",
          provider: "compatible-endpoint",
          credentialEnv: "COMPATIBLE_API_KEY",
          model: "nvidia/model",
        },
        "valid-key",
      ),
    ).toThrow(/gatewayName/);
  });

  it("proves a rejected key cannot cross the destructive boundary and restores idempotently", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-lifecycle-home-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const runner = new FakeRunner();
      enqueueSuccessfulAtomicProof(runner);
      const cleanup = new FakeCleanup();

      const result = await fixture(runner, cleanup).simulate(
        "dcode-rebuild-invalid-credential",
        dcodeInstance(),
        options,
      );

      expect(result.profile).toBe("dcode-rebuild-invalid-credential");
      expect(result.steps.map((step) => step.id)).toContain("nemoclaw-rebuild:invalid-credential");
      expect(cleanup.calls.map((call) => call.name)).toEqual([
        "lifecycle.restore-dcode-provider-credential:nemoclaw:compatible-endpoint",
      ]);

      const providerUpdates = runner.calls.filter(
        (call) =>
          call.command === "openshell" && call.args.slice(0, 2).join(" ") === "provider update",
      );
      expect(providerUpdates).toHaveLength(2);
      const invalidUpdate = providerUpdates[0];
      const badCredential = invalidUpdate.options?.env?.COMPATIBLE_API_KEY;
      expect(badCredential).toMatch(/^nvapi-e2e-invalid-/);
      expect(invalidUpdate.args).toEqual([
        "provider",
        "update",
        "-g",
        "nemoclaw",
        "compatible-endpoint",
        "--credential",
        "COMPATIBLE_API_KEY",
      ]);
      expect(invalidUpdate.args).not.toContain(badCredential);
      expect(invalidUpdate.options?.redactionValues).toEqual([badCredential]);
      expect(providerUpdates[1].options?.env?.COMPATIBLE_API_KEY).toBe(options.validCredential);

      const rebuild = runner.calls.find(
        (call) => call.command === "nemoclaw" && call.args.includes("rebuild"),
      );
      expect(rebuild?.options?.env).not.toHaveProperty("COMPATIBLE_API_KEY");
      const routeProbes = runner.calls.filter(
        (call) =>
          call.command === "openshell" &&
          call.args.some((arg) => arg === "https://inference.local/v1/chat/completions"),
      );
      expect(routeProbes.length).toBeGreaterThanOrEqual(3);
      for (const probe of routeProbes) {
        expect(probe.args).toContain("--data-binary");
        expect(probe.args).not.toContain("https://inference.local/v1/models");
        expect(probe.args.join(" ")).toContain(options.model);
      }
      expect(
        runner.calls.filter(
          (call) =>
            call.command === "docker" &&
            call.args.includes("label=openshell.ai/managed-by=openshell") &&
            call.args.includes(`label=openshell.ai/sandbox-name=${sandboxName}`),
        ),
      ).toHaveLength(2);

      // Cleanup remains armed before onboarding teardown, but becomes a no-op
      // after the explicit finally restoration verified the route and status.
      const callCountBeforeCleanup = runner.calls.length;
      await expect(cleanup.calls[0].run()).resolves.toBeUndefined();
      expect(runner.calls).toHaveLength(callCountBeforeCleanup);

      const repeatedUpdates = runner.calls.filter(
        (call) =>
          call.command === "openshell" && call.args.slice(0, 2).join(" ") === "provider update",
      );
      expect(repeatedUpdates).toHaveLength(2);
    } finally {
      restoreEnv("HOME", previousHome);
      fs.rmSync(home, { force: true, recursive: true });
    }
  });

  it("does not accept a zero rebuild exit as the expected credential rejection", async () => {
    const runner = new FakeRunner();
    enqueueValidatedPreamble(runner);
    runner.enqueue(shellResult(0)); // invalid provider update
    runner.enqueue(shellResult(0, "401"));
    runner.enqueue(shellResult(0, `NAME  PHASE\n${sandboxName}  Ready\n`));
    runner.enqueue(shellResult(0, "unexpected rebuild success"));
    enqueueSuccessfulRestoration(runner);

    await expect(
      fixture(runner, new FakeCleanup()).simulate(
        "dcode-rebuild-invalid-credential",
        dcodeInstance(),
        options,
      ),
    ).rejects.toThrow(/numeric non-zero exit/);
  });

  it("rejects output showing that rebuild crossed the delete boundary", async () => {
    const runner = new FakeRunner();
    enqueueValidatedPreamble(runner);
    runner.enqueue(shellResult(0)); // invalid provider update
    runner.enqueue(shellResult(0, "401"));
    runner.enqueue(shellResult(0, `NAME  PHASE\n${sandboxName}  Ready\n`));
    runner.enqueue(
      shellResult(
        1,
        "recorded inference credentials or route were rejected; HTTP 401\n" +
          "Sandbox is untouched — no data was lost.\n" +
          "Deleting old sandbox...\n",
      ),
    );
    enqueueSuccessfulRestoration(runner);

    await expect(
      fixture(runner, new FakeCleanup()).simulate(
        "dcode-rebuild-invalid-credential",
        dcodeInstance(),
        options,
      ),
    ).rejects.toThrow(/crossed a destructive boundary/);
  });

  it("fails closed before provider mutation when another sandbox shares the gateway", async () => {
    const runner = new FakeRunner();
    runner.enqueue(shellResult(0, `${sandboxName}\nother-sandbox\n`));
    const cleanup = new FakeCleanup();

    await expect(
      fixture(runner, cleanup).simulate(
        "dcode-rebuild-invalid-credential",
        dcodeInstance(),
        options,
      ),
    ).rejects.toThrow(/only sandbox/);
    expect(runner.calls).toHaveLength(1);
    expect(cleanup.calls).toHaveLength(0);
  });

  it("preserves both the primary failure and a restoration failure", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dcode-lifecycle-errors-home-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const runner = new FakeRunner();
      enqueueValidatedPreamble(runner);
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
      enqueueSuccessfulRestoration(runner);
      await expect(cleanup.calls[0].run()).resolves.toBeUndefined();
      const updates = runner.calls.filter(
        (call) =>
          call.command === "openshell" && call.args.slice(0, 2).join(" ") === "provider update",
      );
      expect(updates).toHaveLength(3);
      expect(updates[2].options?.env?.COMPATIBLE_API_KEY).toBe(options.validCredential);
    } finally {
      restoreEnv("HOME", previousHome);
      fs.rmSync(home, { force: true, recursive: true });
    }
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
