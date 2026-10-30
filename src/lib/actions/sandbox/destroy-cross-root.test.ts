// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import {
  MANAGED_GATEWAY_STATE_ROOT_MARKER,
  ensureManagedGatewayStateRoot,
} from "../../onboard/gateway/state-dir";
import type { RetainedSandboxRecoveryRecord } from "../../state/onboard-session/retained-sandbox-recovery";

function writeGatewayRegistry(home: string, port: number, name: string): void {
  const registryDir = path.join(home, ".nemoclaw", "gateways", String(port));
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: name,
      defaultSelectionRevision: 1,
      sandboxes: {
        [name]: {
          name,
          agent: "openclaw",
          provider: "ollama-local",
          model: "nvidia/nemotron",
          gatewayName: `nemoclaw-${String(port)}`,
          gatewayPort: port,
        },
      },
    }),
  );
}

const SIBLING_PORT = 8245;

describe("destroySandbox cross-root registry authority", testTimeoutOptions(30_000), () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-destroy-cross-root-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("NEMOCLAW_CLEANUP_GATEWAY", "");
    vi.stubEnv("NEMOCLAW_KEEP_VLLM", "");
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetDestroyModuleCache();
    fs.rmSync(home, { force: true, recursive: true });
  });

  function writeSiblingRegistry(
    names: readonly string[],
    entryOverrides: Readonly<Record<string, unknown>> = {},
  ): string {
    const registryDir = path.join(home, ".nemoclaw", "gateways", String(SIBLING_PORT));
    const registryFile = path.join(registryDir, "sandboxes.json");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      registryFile,
      JSON.stringify({
        defaultSandbox: names[0] ?? null,
        defaultSelectionRevision: 1,
        sandboxes: Object.fromEntries(
          names.map((name) => [
            name,
            {
              name,
              agent: "openclaw",
              provider: "ollama-local",
              model: "nvidia/nemotron",
              gatewayName: `nemoclaw-${String(SIBLING_PORT)}`,
              gatewayPort: SIBLING_PORT,
              ...entryOverrides,
            },
          ]),
        ),
      }),
    );
    return registryFile;
  }

  function registeredNames(registryFile: string): string[] {
    return Object.keys(JSON.parse(fs.readFileSync(registryFile, "utf8")).sandboxes);
  }

  it("runs a sibling-root destroy in a worker bound to the owning gateway root", async () => {
    const registryFile = writeSiblingRegistry(["alpha"]);
    const harness = createDestroyHarness();

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: false }),
    ).resolves.toBeUndefined();

    expect(harness.runOwningRegistryWorkerSpy).toHaveBeenCalledWith(
      {
        operation: "destroy",
        sandboxName: "alpha",
        options: { yes: true, cleanupGateway: false },
      },
      SIBLING_PORT,
    );
    expect(harness.executeSandboxDestroySpy).not.toHaveBeenCalled();
    expect(harness.compareAndSwapSessionSpy).not.toHaveBeenCalled();
    expect(registeredNames(registryFile)).toEqual(["alpha"]);
  });

  it("removes the sandbox from its registry when the owning root runs the destroy", async () => {
    const registryFile = writeSiblingRegistry(["alpha"]);
    const harness = createDestroyHarness();

    await expect(
      harness.destroySandboxInSelectedRoot("alpha", { yes: true, cleanupGateway: false }),
    ).resolves.toBeUndefined();

    expect(JSON.parse(fs.readFileSync(registryFile, "utf8"))).toMatchObject({
      defaultSandbox: null,
      defaultSelectionRevision: 2,
      sandboxes: {},
    });
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "list", "-g", "nemoclaw-8245", "-o", "json"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.runOwningRegistryWorkerSpy).not.toHaveBeenCalled();
  });

  it("cleans up the destroyed gateway while preserving a sandbox on another gateway", async () => {
    writeGatewayRegistry(home, 8244, "alpha");
    writeGatewayRegistry(home, 8245, "beta");
    const harness = createDestroyHarness();

    await expect(
      harness.destroySandboxInSelectedRoot("beta", { yes: true, cleanupGateway: true }),
    ).resolves.toBeUndefined();

    expect(harness.cleanupGatewaySpy).toHaveBeenCalledWith("nemoclaw-8245", expect.any(Function));
    expect(harness.cleanupGatewaySpy).toHaveBeenCalledOnce();
    expect(
      JSON.parse(
        fs.readFileSync(path.join(home, ".nemoclaw", "gateways", "8244", "sandboxes.json"), "utf8"),
      ),
    ).toMatchObject({ sandboxes: { alpha: { name: "alpha" } } });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(home, ".nemoclaw", "gateways", "8245", "sandboxes.json"), "utf8"),
      ),
    ).toMatchObject({ sandboxes: {} });
  });

  it("preserves the destroyed gateway when onboarding reserves its route before final cleanup", async () => {
    writeGatewayRegistry(home, 8244, "alpha");
    writeGatewayRegistry(home, 8245, "beta");
    const betaRegistryFile = path.join(home, ".nemoclaw", "gateways", "8245", "sandboxes.json");
    const harness = createDestroyHarness();
    harness.withGatewayRouteMutationLockSpy
      .mockImplementationOnce(async (_gatewayName: unknown, operation: unknown) =>
        (operation as () => Promise<unknown>)(),
      )
      .mockImplementationOnce(async (_gatewayName: unknown, operation: unknown) => {
        const betaRegistry = JSON.parse(fs.readFileSync(betaRegistryFile, "utf8")) as {
          sandboxes: Record<string, unknown>;
        };
        betaRegistry.sandboxes.gamma = {
          name: "gamma",
          agent: "openclaw",
          provider: "ollama-local",
          model: "nvidia/nemotron",
          gatewayName: "nemoclaw-8245",
          gatewayPort: 8245,
          pendingRouteReservation: true,
          reservationSessionId: "session-gamma",
        };
        fs.writeFileSync(betaRegistryFile, JSON.stringify(betaRegistry));
        return (operation as () => Promise<unknown>)();
      });

    await expect(
      harness.destroySandboxInSelectedRoot("beta", { yes: true, cleanupGateway: true }),
    ).rejects.toThrow("Sandbox destroy requested exit 1");

    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(harness.withGatewayRouteMutationLockSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(betaRegistryFile, "utf8"))).toMatchObject({
      sandboxes: { gamma: { name: "gamma", pendingRouteReservation: true } },
    });
  });

  it(
    "preserves a pending sibling-root owner during a registry-absent retained destroy retry",
    { timeout: 30_000 },
    async () => {
      writeGatewayRegistry(home, 8245, "gamma");
      const registryFile = path.join(home, ".nemoclaw", "gateways", "8245", "sandboxes.json");
      const gatewayRegistry = JSON.parse(fs.readFileSync(registryFile, "utf8")) as {
        sandboxes: Record<string, Record<string, unknown>>;
      };
      gatewayRegistry.sandboxes.gamma!.pendingRouteReservation = true;
      gatewayRegistry.sandboxes.gamma!.reservationSessionId = "session-gamma";
      fs.writeFileSync(registryFile, JSON.stringify(gatewayRegistry));
      const recovery: RetainedSandboxRecoveryRecord = {
        schemaVersion: 1,
        recordId: "f".repeat(64),
        sandboxName: "alpha",
        sandboxIdentityFingerprint: createHash("sha256").update("sb-alpha").digest("hex"),
        identityWasUnavailable: false,
        gatewayName: "nemoclaw-8245",
        gatewayPort: 8245,
        lifecycleGeneration: "generation-alpha",
        createAttemptNonce: "c".repeat(62),
        resources: {
          sharedInferenceProviders: [],
          sandboxScopedProviders: [],
          credentialEnvironmentVariables: [],
        },
        reason: "retained_after_sandbox_creation_failure",
        recordedAt: "2026-08-28T00:00:00.000Z",
      };
      const harness = createDestroyHarness({
        registryEntryPresent: false,
        sandboxPresent: false,
        dockerRunResult: { status: 0, stdout: "" },
        retainedRecoveryRecords: [recovery],
      });

      await expect(
        harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
      ).resolves.toBeUndefined();

      expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
      expect(harness.resolveRetainedSandboxRecoverySpy).toHaveBeenCalledWith(recovery);
      expect(JSON.parse(fs.readFileSync(registryFile, "utf8"))).toMatchObject({
        sandboxes: { gamma: { pendingRouteReservation: true } },
      });
    },
  );

  it("preserves the gateway when another sibling-root sandbox remains", async () => {
    const registryDir = path.join(home, ".nemoclaw", "gateways", "8245");
    const registryFile = path.join(registryDir, "sandboxes.json");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      registryFile,
      JSON.stringify({
        defaultSandbox: "alpha",
        defaultSelectionRevision: 1,
        sandboxes: {
          alpha: {
            name: "alpha",
            agent: "openclaw",
            provider: "ollama-local",
            model: "nvidia/nemotron",
            gatewayName: "nemoclaw-8245",
            gatewayPort: 8245,
          },
          beta: {
            name: "beta",
            agent: "openclaw",
            provider: "ollama-local",
            model: "nvidia/nemotron",
            gatewayName: "nemoclaw-8245",
            gatewayPort: 8245,
          },
        },
      }),
    );
    const harness = createDestroyHarness();

    await expect(
      harness.destroySandboxInSelectedRoot("alpha", { yes: true, cleanupGateway: true }),
    ).resolves.toBeUndefined();

    expect(JSON.parse(fs.readFileSync(registryFile, "utf8"))).toMatchObject({
      defaultSandbox: "beta",
      sandboxes: { beta: { name: "beta" } },
    });
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });

  it("confirms a sibling-root destroy in the caller and declines gateway cleanup while other sandboxes remain", async () => {
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "0");
    writeSiblingRegistry(["alpha", "beta"]);
    const harness = createDestroyHarness({ promptResponses: ["yes"] });

    await expect(harness.destroySandbox("alpha")).resolves.toBeUndefined();

    expect(harness.promptSpy).toHaveBeenCalledOnce();
    expect(harness.runOwningRegistryWorkerSpy).toHaveBeenCalledWith(
      {
        operation: "destroy",
        sandboxName: "alpha",
        options: { yes: true, cleanupGatewayPromptAnswer: false },
      },
      SIBLING_PORT,
    );
  });

  it("declines gateway cleanup before delegation when another sandbox has a pending route", async () => {
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "0");
    const registryFile = writeSiblingRegistry(["alpha"]);
    const registryState = JSON.parse(fs.readFileSync(registryFile, "utf8")) as {
      sandboxes: Record<string, unknown>;
    };
    registryState.sandboxes.beta = {
      name: "beta",
      gatewayName: `nemoclaw-${String(SIBLING_PORT)}`,
      gatewayPort: SIBLING_PORT,
      pendingRouteReservation: true,
      reservationSessionId: "session-beta",
    };
    fs.writeFileSync(registryFile, JSON.stringify(registryState));
    const harness = createDestroyHarness({ promptResponses: ["yes"] });

    await expect(harness.destroySandbox("alpha")).resolves.toBeUndefined();

    expect(harness.promptSpy).toHaveBeenCalledOnce();
    expect(harness.runOwningRegistryWorkerSpy).toHaveBeenCalledWith(
      {
        operation: "destroy",
        sandboxName: "alpha",
        options: { yes: true, cleanupGatewayPromptAnswer: false },
      },
      SIBLING_PORT,
    );
    expect(registeredNames(registryFile)).toEqual(["alpha", "beta"]);
  });

  it("refuses an endpoint override before sibling-root confirmation or worker execution", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://other.example.test");
    writeSiblingRegistry(["alpha"]);
    const harness = createDestroyHarness({ promptResponses: ["yes"] });

    await expect(harness.destroySandbox("alpha")).rejects.toThrow(
      "OPENSHELL_GATEWAY_ENDPOINT is set",
    );

    expect(harness.promptSpy).not.toHaveBeenCalled();
    expect(harness.runOwningRegistryWorkerSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
  });

  it("does not start the worker when the caller cancels a sibling-root destroy", async () => {
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "0");
    const registryFile = writeSiblingRegistry(["alpha"]);
    const harness = createDestroyHarness({ promptResponses: ["no"] });

    await expect(harness.destroySandbox("alpha")).resolves.toBeUndefined();

    expect(harness.runOwningRegistryWorkerSpy).not.toHaveBeenCalled();
    expect(harness.executeSandboxDestroySpy).not.toHaveBeenCalled();
    expect(registeredNames(registryFile)).toEqual(["alpha"]);
    expect(harness.recordTelemetryTargetSpy).toHaveBeenCalledExactlyOnceWith({
      scope: "sandbox",
      sandboxName: "alpha",
      gatewayName: `nemoclaw-${String(SIBLING_PORT)}`,
      outcome: "cancelled",
      state: "unchanged",
    });
  });

  it("asks the final gateway question and cleans up the owning gateway when the worker destroys the last sandbox in its owning root", async () => {
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "0");
    const defaultRegistryDir = path.join(home, ".nemoclaw");
    const defaultRegistryFile = path.join(defaultRegistryDir, "sandboxes.json");
    fs.mkdirSync(defaultRegistryDir, { recursive: true });
    fs.writeFileSync(
      defaultRegistryFile,
      JSON.stringify({
        defaultSandbox: "default-box",
        defaultSelectionRevision: 1,
        sandboxes: {
          "default-box": {
            name: "default-box",
            agent: "openclaw",
            provider: "ollama-local",
            model: "nvidia/nemotron",
            gatewayName: "nemoclaw",
            gatewayPort: 8080,
          },
        },
      }),
    );
    const siblingRegistryFile = writeSiblingRegistry(["alpha"]);
    const harness = createDestroyHarness({ promptResponses: ["yes", "yes"] });
    harness.runOwningRegistryWorkerSpy.mockImplementationOnce(async (input) => {
      await harness.destroySandboxInSelectedRoot(
        input.sandboxName,
        input.options as Parameters<typeof harness.destroySandboxInSelectedRoot>[1],
      );
    });

    await expect(harness.destroySandbox("alpha")).resolves.toBeUndefined();

    expect(harness.promptSpy).toHaveBeenCalledTimes(2);
    expect(harness.runOwningRegistryWorkerSpy).toHaveBeenCalledWith(
      {
        operation: "destroy",
        sandboxName: "alpha",
        options: { yes: true, cleanupGatewayPromptAnswer: true },
      },
      SIBLING_PORT,
    );
    expect(registeredNames(siblingRegistryFile)).toEqual([]);
    expect(registeredNames(defaultRegistryFile)).toEqual(["default-box"]);
    expect(harness.stopAllSpy).not.toHaveBeenCalled();
    expect(harness.cleanupGatewaySpy).toHaveBeenCalledExactlyOnceWith(
      `nemoclaw-${String(SIBLING_PORT)}`,
      expect.any(Function),
    );
  });

  it("exits with the status that the owning-root destroy reports", async () => {
    writeSiblingRegistry(["alpha"]);
    const harness = createDestroyHarness();
    harness.runOwningRegistryWorkerSpy.mockRejectedValueOnce(
      new Error("Delegated destroy exited with status 3.", {
        cause: {
          ok: false,
          operation: "destroy",
          sandboxName: "alpha",
          gatewayPort: SIBLING_PORT,
          exitCode: 3,
        },
      }),
    );

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(3)");
  });

  it("records one partial completion for the owning gateway when a delegated worker fails after mutation", async () => {
    writeSiblingRegistry(["alpha"]);
    const harness = createDestroyHarness({
      managedAgentStateVolumeCleanupResults: [
        {
          status: "failed",
          volumeName: "nemoclaw-openclaw-alpha",
          detail: "volume in use",
        },
      ],
    });
    harness.runOwningRegistryWorkerSpy.mockImplementationOnce(async (input, gatewayPort) => {
      expect(input.operation).toBe("destroy");
      try {
        await harness.destroySandboxInSelectedRoot(
          input.sandboxName,
          input.options as Parameters<typeof harness.destroySandboxInSelectedRoot>[1],
        );
      } catch (error) {
        const exitCode = harness.sandboxDestroyExitCode(error);
        throw new Error(`Delegated destroy exited with status ${String(exitCode)}.`, {
          cause: {
            ok: false,
            operation: "destroy",
            sandboxName: input.sandboxName,
            gatewayPort,
            ...(exitCode === undefined ? {} : { exitCode }),
          },
        });
      }
    });

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow("process.exit(1)");

    expect(harness.recordDestroyCompletionSpy).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      "failed",
      1,
      `nemoclaw-${String(SIBLING_PORT)}`,
      true,
    );
    expect(harness.recordTelemetryTargetSpy).toHaveBeenCalledExactlyOnceWith({
      scope: "sandbox",
      sandboxName: "alpha",
      gatewayName: `nemoclaw-${String(SIBLING_PORT)}`,
      outcome: "failed",
      state: "partial",
    });
  });

  it("reports a worker failure that carries no destroy exit status", async () => {
    writeSiblingRegistry(["alpha"]);
    const harness = createDestroyHarness();
    harness.runOwningRegistryWorkerSpy.mockRejectedValueOnce(
      new Error("Delegated destroy in the owning gateway registry did not complete successfully."),
    );

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
      "Delegated destroy in the owning gateway registry did not complete successfully.",
    );
  });

  it("refuses to hand a sibling-root destroy to a worker while this process holds the host fence and names the invoking CLI", async () => {
    vi.stubEnv("NEMOCLAW_INVOKED_AS", "nemohermes");
    writeSiblingRegistry(["alpha"]);
    const harness = createDestroyHarness({ invokedCliName: "nemohermes" });
    vi.spyOn(harness.owningRegistryDependencies, "isHostFenceHeld").mockReturnValue(true);

    await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(
      "Cannot transfer destroy for 'alpha' while another lifecycle command owns the host fence. Run 'nemohermes alpha destroy' directly.",
    );
    expect(harness.runOwningRegistryWorkerSpy).not.toHaveBeenCalled();
  });

  it("binds a sibling-root destroy worker to the owning entry's gateway state directory instead of the caller's override", async () => {
    const stateRootParent = fs.mkdtempSync(
      path.join(process.cwd(), "nemoclaw-destroy-gateway-state-"),
    );
    try {
      const callerStateDir = path.join(home, "caller-gateway-state");
      const owningStateDir = path.join(stateRootParent, "sibling-gateway-state");
      ensureManagedGatewayStateRoot({
        gatewayName: `nemoclaw-${String(SIBLING_PORT)}`,
        gatewayPort: SIBLING_PORT,
        stateDir: owningStateDir,
      });
      vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", callerStateDir);
      writeSiblingRegistry(["alpha"], { openshellGatewayStateDir: owningStateDir });
      const harness = createDestroyHarness();

      await expect(
        harness.destroySandbox("alpha", { yes: true, cleanupGateway: false }),
      ).resolves.toBeUndefined();

      expect(harness.runOwningRegistryWorkerSpy).toHaveBeenCalledWith(
        {
          operation: "destroy",
          sandboxName: "alpha",
          options: { yes: true, cleanupGateway: false },
        },
        SIBLING_PORT,
        { gatewayStateDir: owningStateDir },
      );
    } finally {
      fs.rmSync(stateRootParent, { force: true, recursive: true });
    }
  });

  it.each([
    [
      "a missing managed-root marker",
      (stateDir: string) => {
        fs.mkdirSync(stateDir, { mode: 0o700, recursive: true });
      },
      /Unsafe OpenShell gateway state directory:.*managed gateway state root marker and legacy managed configuration are both missing/,
    ],
    [
      "a managed-root marker for another gateway",
      (stateDir: string) => {
        ensureManagedGatewayStateRoot({
          gatewayName: "nemoclaw-9999",
          gatewayPort: 9999,
          stateDir,
        });
      },
      /Unsafe OpenShell gateway state directory:.*does not identify the selected gateway and directory/,
    ],
    [
      "an unsafe managed-root marker mode",
      (stateDir: string) => {
        ensureManagedGatewayStateRoot({
          gatewayName: `nemoclaw-${String(SIBLING_PORT)}`,
          gatewayPort: SIBLING_PORT,
          stateDir,
        });
        fs.chmodSync(path.join(stateDir, MANAGED_GATEWAY_STATE_ROOT_MARKER), 0o644);
      },
      /Unsafe OpenShell gateway state directory:.*not a private owned regular file/,
    ],
  ])(
    "rejects a sibling-root destroy before starting the worker when openshellGatewayStateDir has %s",
    async (_caseLabel, prepareStateDir, expectedError) => {
      vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "0");
      const stateRootParent = fs.mkdtempSync(
        path.join(process.cwd(), "nemoclaw-destroy-untrusted-gateway-state-"),
      );
      try {
        const owningStateDir = path.join(stateRootParent, "sibling-gateway-state");
        prepareStateDir(owningStateDir);
        writeSiblingRegistry(["alpha"], { openshellGatewayStateDir: owningStateDir });
        const harness = createDestroyHarness();

        await expect(harness.destroySandbox("alpha")).rejects.toThrow(expectedError);

        expect(harness.promptSpy).not.toHaveBeenCalled();
        expect(harness.runOwningRegistryWorkerSpy).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(stateRootParent, { force: true, recursive: true });
      }
    },
  );

  it("transfers a sibling-root destroy before the real CLI takes its lifecycle fence", async () => {
    const registryFile = writeSiblingRegistry(["alpha"]);
    const harness = createDestroyHarness();

    await harness.destroyCommand.run(["alpha", "--yes", "--no-cleanup-gateway"], process.cwd());

    expect(harness.runOwningRegistryWorkerSpy).toHaveBeenCalledWith(
      {
        operation: "destroy",
        sandboxName: "alpha",
        options: { yes: true, cleanupGateway: false, force: false },
      },
      SIBLING_PORT,
    );
    expect(harness.lifecycleLockEvents).toEqual([]);
    expect(harness.executeSandboxDestroySpy).not.toHaveBeenCalled();
    expect(registeredNames(registryFile)).toEqual(["alpha"]);
  });

  it("does not transfer a sibling-root destroy from a CLI already under an unrelated host fence", async () => {
    writeSiblingRegistry(["alpha"]);
    const harness = createDestroyHarness();

    await expect(
      harness.withPortableHostFence(home, () =>
        harness.destroyCommand.run(["alpha", "--yes"], process.cwd()),
      ),
    ).rejects.toThrow("Cannot transfer destroy for 'alpha'");
    expect(harness.runOwningRegistryWorkerSpy).not.toHaveBeenCalled();
  });
});
