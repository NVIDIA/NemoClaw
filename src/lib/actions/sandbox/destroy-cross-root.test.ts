// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
    expect(harness.selectGatewaySpy).toHaveBeenCalledWith(
      "alpha",
      `nemoclaw-${String(SIBLING_PORT)}`,
      expect.anything(),
      undefined,
    );
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.runOwningRegistryWorkerSpy).not.toHaveBeenCalled();
  });

  it("preserves the gateway when another sandbox remains in the owning registry", async () => {
    const registryFile = writeSiblingRegistry(["alpha", "beta"]);
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

  it("does not start the worker when the caller cancels a sibling-root destroy", async () => {
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "0");
    const registryFile = writeSiblingRegistry(["alpha"]);
    const harness = createDestroyHarness({ promptResponses: ["no"] });

    await expect(harness.destroySandbox("alpha")).resolves.toBeUndefined();

    expect(harness.runOwningRegistryWorkerSpy).not.toHaveBeenCalled();
    expect(harness.executeSandboxDestroySpy).not.toHaveBeenCalled();
    expect(registeredNames(registryFile)).toEqual(["alpha"]);
  });

  it("asks the final gateway question before the worker destroys the last sandbox", async () => {
    vi.stubEnv("NEMOCLAW_NON_INTERACTIVE", "0");
    writeSiblingRegistry(["alpha"]);
    const harness = createDestroyHarness({ promptResponses: ["yes", "yes"] });

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
      /managed gateway state root marker and legacy managed configuration are both missing/,
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
      /does not identify the selected gateway and directory/,
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
      /not a private owned regular file/,
    ],
  ])(
    "rejects a sibling-root destroy before starting the worker when openshellGatewayStateDir has %s",
    async (_caseLabel, prepareStateDir, expectedError) => {
      const stateRootParent = fs.mkdtempSync(
        path.join(process.cwd(), "nemoclaw-destroy-untrusted-gateway-state-"),
      );
      try {
        const owningStateDir = path.join(stateRootParent, "sibling-gateway-state");
        prepareStateDir(owningStateDir);
        writeSiblingRegistry(["alpha"], { openshellGatewayStateDir: owningStateDir });
        const harness = createDestroyHarness();

        await expect(harness.destroySandbox("alpha", { yes: true })).rejects.toThrow(expectedError);

        expect(harness.promptSpy).not.toHaveBeenCalled();
        expect(harness.runOwningRegistryWorkerSpy).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(stateRootParent, { force: true, recursive: true });
      }
    },
  );
});
