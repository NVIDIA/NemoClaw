// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configureSiblingSandboxAfterDelete,
  createDestroyHarness,
  resetDestroyModuleCache,
} from "../../../../test/helpers/destroy-flow-test-harness";
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

describe("destroySandbox cross-root registry authority", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-destroy-cross-root-"));
    vi.stubEnv("HOME", home);
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

  it("removes the sandbox from its sibling gateway registry", async () => {
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
        },
      }),
    );
    const harness = createDestroyHarness();

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: false }),
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
  });

  it("cleans up the destroyed gateway while preserving a sandbox on another gateway", async () => {
    writeGatewayRegistry(home, 8244, "alpha");
    writeGatewayRegistry(home, 8245, "beta");
    const harness = createDestroyHarness({
      sandboxListResult: {
        status: 0,
        stdout: "NAME PHASE\nalpha Ready\nbeta Ready",
        stderr: "",
      },
    });
    configureSiblingSandboxAfterDelete(harness, "beta", ["alpha"]);

    await expect(
      harness.destroySandbox("beta", { yes: true, cleanupGateway: true }),
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
    const harness = createDestroyHarness({
      sandboxListResult: {
        status: 0,
        stdout: "NAME PHASE\nalpha Ready\nbeta Ready",
        stderr: "",
      },
    });
    configureSiblingSandboxAfterDelete(harness, "beta", ["alpha"]);
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
      harness.destroySandbox("beta", { yes: true, cleanupGateway: true }),
    ).rejects.toThrow("process.exit(1)");

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
    const harness = createDestroyHarness({
      sandboxListResult: {
        status: 0,
        stdout: "NAME PHASE\nalpha Ready\nbeta Ready",
        stderr: "",
      },
    });

    await expect(
      harness.destroySandbox("alpha", { yes: true, cleanupGateway: true }),
    ).resolves.toBeUndefined();

    expect(JSON.parse(fs.readFileSync(registryFile, "utf8"))).toMatchObject({
      defaultSandbox: "beta",
      sandboxes: { beta: { name: "beta" } },
    });
    expect(harness.cleanupGatewaySpy).not.toHaveBeenCalled();
    expect(harness.unloadOllamaModelsSpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });
});
