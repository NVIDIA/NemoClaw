// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readGatewayRegistryFile } from "../../state/gateway-registry";
import { assertHermesPortableUninstallCompleteForOnboarding } from "../../state/hermes-portable-uninstall/journal";
import { withPortableOnboardRetirementBoundary } from "../../onboard/portable-retirement-authority";
import { readHermesPortableLifecycleReceipt } from "../../onboard/experimental/hermes-portable-receipt";
import { runHermesPortableOnboardingTransaction } from "../../onboard/experimental/hermes-portable-onboarding";
import {
  createHermesPortableUninstallFixture,
  hermesPortableUninstallFixtureConstants,
  type HermesPortableUninstallFixture,
} from "../../../../test/helpers/hermes-portable-uninstall-fixture";
import {
  createHermesPortableTestInput,
  createHermesPortableTransactionFixture,
} from "../../../../test/helpers/hermes-portable-onboarding-fixture";
import { runPortableRuntimeCleanupTransaction } from "./portable-runtime-cleanup";
import { inspectHermesPortableUninstallJournal } from "./hermes-portable-uninstall-transaction";

let homeDir: string;
let fixture: HermesPortableUninstallFixture | undefined;

function runCleanup(target: HermesPortableUninstallFixture) {
  const legacyOpenShell = vi.fn(() => true);
  const result = runPortableRuntimeCleanupTransaction(target.cleanupInput, legacyOpenShell, {
    hermesPortable: target.deps,
    withRegistryLock: (_registryFile, operation) => operation(),
  });
  expect(legacyOpenShell).not.toHaveBeenCalled();
  return result;
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(`${os.tmpdir()}/nemoclaw-hermes-portable-uninstall-`);
});

afterEach(() => {
  fixture?.restore();
  fixture = undefined;
  fs.rmSync(homeDir, { force: true, recursive: true });
});

describe("Hermes Portable schema-5 uninstall", () => {
  it("retires exact owned resources, preserves unrelated state, and completes a second no-op (#9608)", async () => {
    fixture = await createHermesPortableUninstallFixture(homeDir);
    const image = hermesPortableUninstallFixtureConstants.inferenceImage;

    expect(runCleanup(fixture)).toMatchObject({
      sandboxContainersRemoved: 1,
      selectorsRemoved: [],
    });
    expect(fixture.sandboxPresent()).toBe(false);
    expect(fixture.sandboxDeleteCount()).toBe(1);
    expect(fixture.gatewayProvider.isPresent()).toBe(false);
    expect(fixture.harness.container()).toBeNull();
    expect(fixture.authorityState.images?.has(image)).toBe(true);
    expect(fs.existsSync(fixture.unrelatedFile)).toBe(true);
    expect(fs.readdirSync(fixture.lifecycleReceiptRoot)).toEqual([]);
    expect(
      readGatewayRegistryFile(homeDir, fixture.registryFile)?.sandboxes[
        hermesPortableUninstallFixtureConstants.sandboxName
      ],
    ).toBeUndefined();
    expect(inspectHermesPortableUninstallJournal(fixture.stateDir)?.phase).toBe("completed");

    const eventCount = fixture.operationEvents.length;
    const providerCallCount = fixture.gatewayProvider.calls().length;
    expect(runCleanup(fixture)).toMatchObject({ sandboxContainersRemoved: 0 });
    expect(fixture.operationEvents).toHaveLength(eventCount);
    expect(fixture.gatewayProvider.calls()).toHaveLength(providerCallCount);
    expect(fixture.sandboxDeleteCount()).toBe(1);
  });

  it("replaces completed journal authority after a later install (#9608)", async () => {
    fixture = await createHermesPortableUninstallFixture(homeDir);
    expect(runCleanup(fixture)).toMatchObject({ sandboxContainersRemoved: 1 });
    const firstAuthority = inspectHermesPortableUninstallJournal(fixture.stateDir)?.authoritySha256;

    fixture.restore();
    fixture = await createHermesPortableUninstallFixture(homeDir);
    expect(runCleanup(fixture)).toMatchObject({ sandboxContainersRemoved: 1 });
    expect(inspectHermesPortableUninstallJournal(fixture.stateDir)?.authoritySha256).not.toBe(
      firstAuthority,
    );
    expect(fixture.sandboxDeleteCount()).toBe(1);
  });

  it("blocks replacement onboarding during receipts-retired recovery and later uninstalls a new generation (#9608)", async () => {
    fixture = await createHermesPortableUninstallFixture(homeDir, {
      interruptAfter: "receipts-retired",
    });
    expect(() => runCleanup(fixture!)).toThrow("interrupted after receipts-retired");

    const blockedOperation = vi.fn();
    await expect(
      withPortableOnboardRetirementBoundary(
        {
          homeDir,
          registryFile: fixture.registryFile,
          sessionFile: path.join(fixture.stateDir, "onboard-session.json"),
          stateDir: fixture.stateDir,
        },
        blockedOperation,
        {
          loadRegistry: () => ({ defaultSandbox: null, sandboxes: {} }),
          withLifecycleLock: async (_sandboxName, operation) => await operation(),
        },
      ),
    ).rejects.toThrow("uninstall journal is at phase 'receipts-retired'");
    expect(blockedOperation).not.toHaveBeenCalled();

    const baseInput = createHermesPortableTestInput(
      fixture.stateDir,
      path.join(fixture.stateDir, "replacement-policy.yaml"),
    );
    const replacementName = hermesPortableUninstallFixtureConstants.sandboxName;
    const replaceName = (value: string) => value.replaceAll("alpha", replacementName);
    const replacementInput = {
      ...baseInput,
      sandboxName: replacementName,
      lifecycleGeneration: "generation-2",
      createArgv: baseInput.createArgv.map(replaceName),
      startup: {
        ...baseInput.startup,
        sandboxName: replacementName,
        startupArgv: baseInput.startup.startupArgv.map(replaceName),
      },
    };
    const replacementOnboarding = createHermesPortableTransactionFixture(replacementInput);
    await expect(
      runHermesPortableOnboardingTransaction(replacementInput, replacementOnboarding.value),
    ).rejects.toThrow("uninstall journal is at phase 'receipts-retired'");
    expect(replacementOnboarding.events).toEqual(["lock-enter", "lock-exit"]);
    expect(replacementInput.buildContext.assertCurrentSource).not.toHaveBeenCalled();

    expect(runCleanup(fixture)).toMatchObject({ sandboxContainersRemoved: 0 });
    expect(inspectHermesPortableUninstallJournal(fixture.stateDir)?.phase).toBe("completed");
    expect(() =>
      assertHermesPortableUninstallCompleteForOnboarding(fixture!.stateDir),
    ).not.toThrow();

    fixture.restore();
    fixture = await createHermesPortableUninstallFixture(homeDir, {
      lifecycleGeneration: "generation-2",
    });
    expect(fixture.targetRow.lifecycleGeneration).toBe("generation-2");
    expect(runCleanup(fixture)).toMatchObject({ sandboxContainersRemoved: 1 });
    expect(inspectHermesPortableUninstallJournal(fixture.stateDir)?.phase).toBe("completed");
  });

  it("preserves a provider, inference runtime, and recovery evidence shared by a sibling (#9608)", async () => {
    fixture = await createHermesPortableUninstallFixture(homeDir, { shared: true });

    expect(runCleanup(fixture)).toMatchObject({ sandboxContainersRemoved: 1 });
    expect(fixture.gatewayProvider.isPresent()).toBe(true);
    expect(fixture.harness.container()).not.toBeNull();
    expect(fs.existsSync(fixture.inferenceDirectory)).toBe(true);
    expect(fs.readdirSync(fixture.lifecycleReceiptRoot)).toEqual([]);
    expect(fs.existsSync(fixture.unrelatedFile)).toBe(true);
    expect(Object.keys(readGatewayRegistryFile(homeDir, fixture.registryFile)!.sandboxes)).toEqual([
      "portable-sibling",
    ]);

    const eventCount = fixture.operationEvents.length;
    expect(runCleanup(fixture)).toMatchObject({ sandboxContainersRemoved: 0 });
    expect(fixture.operationEvents).toHaveLength(eventCount);
    expect(fixture.gatewayProvider.isPresent()).toBe(true);
    expect(fixture.harness.container()).not.toBeNull();
  });

  it("preserves a shared provider while retiring an exclusive inference runtime (#9608)", async () => {
    fixture = await createHermesPortableUninstallFixture(homeDir, {
      providerOnlyShared: true,
    });

    expect(runCleanup(fixture)).toMatchObject({ sandboxContainersRemoved: 1 });
    expect(fixture.gatewayProvider.isPresent()).toBe(true);
    expect(fixture.harness.container()).toBeNull();
    expect(fs.existsSync(fixture.inferenceDirectory)).toBe(true);
    expect(Object.keys(readGatewayRegistryFile(homeDir, fixture.registryFile)!.sandboxes)).toEqual([
      "provider-sibling",
    ]);

    const eventCount = fixture.operationEvents.length;
    expect(runCleanup(fixture)).toMatchObject({ sandboxContainersRemoved: 0 });
    expect(fixture.operationEvents).toHaveLength(eventCount);
    expect(fixture.gatewayProvider.isPresent()).toBe(true);
    expect(fixture.harness.container()).toBeNull();
  });

  it.each([
    "prepared",
    "sandboxes-retired",
    "providers-retired",
    "inference-retired",
    "resources-absent",
    "registry-retired",
    "receipts-retired",
  ] as const)("resumes the real transaction after the %s action (#9608)", async (phase) => {
    fixture = await createHermesPortableUninstallFixture(homeDir, { interruptAfter: phase });

    expect(() => runCleanup(fixture!)).toThrow(`interrupted after ${phase}`);
    expect(inspectHermesPortableUninstallJournal(fixture.stateDir)?.phase).toBe(phase);
    expect(runCleanup(fixture)).toMatchObject({ sandboxContainersRemoved: 0 });
    expect(inspectHermesPortableUninstallJournal(fixture.stateDir)?.phase).toBe("completed");

    const eventCount = fixture.operationEvents.length;
    expect(runCleanup(fixture)).toMatchObject({ sandboxContainersRemoved: 0 });
    expect(fixture.operationEvents).toHaveLength(eventCount);
    expect(fixture.sandboxDeleteCount()).toBe(1);
    expect(
      fixture.gatewayProvider
        .calls()
        .filter(({ args }) => args[0] === "provider" && args[1] === "delete"),
    ).toHaveLength(1);
  });

  it.each([
    [
      "provider profile",
      (target: HermesPortableUninstallFixture) =>
        target.gatewayProvider.setCredentialEnv(
          `${target.gatewayProvider.credentialEnv()},SPOOFED_PROFILE`,
        ),
      "ambiguous gateway provider authority",
    ],
    [
      "socket",
      (target: HermesPortableUninstallFixture) => target.setSocketDrift(),
      "socket authority drift",
    ],
    [
      "stale readiness",
      (target: HermesPortableUninstallFixture) => target.setSandboxPhase("Creating"),
      "OpenShell sandbox identity disagrees",
    ],
  ] as const)("rejects %s drift before mutation (#9608)", async (_name, mutate, message) => {
    fixture = await createHermesPortableUninstallFixture(homeDir);
    mutate(fixture);

    expect(() => runCleanup(fixture!)).toThrow(message);
    expect(fixture.sandboxDeleteCount()).toBe(0);
    expect(fixture.gatewayProvider.isPresent()).toBe(true);
    expect(fixture.harness.container()).not.toBeNull();
    expect(inspectHermesPortableUninstallJournal(fixture.stateDir)).toBeNull();
  });

  it("rejects a same-name sandbox replacement during retry before later mutation (#9608)", async () => {
    fixture = await createHermesPortableUninstallFixture(homeDir, {
      interruptAfter: "prepared",
    });

    expect(() => runCleanup(fixture!)).toThrow("interrupted after prepared");
    fixture.replaceSandbox();
    expect(() => runCleanup(fixture!)).toThrow("OpenShell sandbox identity disagrees");
    expect(fixture.sandboxDeleteCount()).toBe(1);
    expect(fixture.gatewayProvider.isPresent()).toBe(true);
    expect(fixture.harness.container()).not.toBeNull();
    expect(readHermesPortableLifecycleReceipt("portable-hermes", fixture.stateDir)).not.toBeNull();
  });

  it.each([
    [
      "sandbox container ID",
      "setSandboxContainerIdDrift",
      "Hermes portable container authority inspect returned another container ID",
    ],
    [
      "sandbox label delimiter",
      "setSandboxLabelDelimiterDrift",
      "Hermes portable container authority inspect label 'openshell.ai/sandbox-name' disagrees with OpenShell",
    ],
    [
      "registry lifecycle generation",
      "setRegistryGenerationDrift",
      "Hermes Portable uninstall registry row 'portable-hermes' is incomplete",
    ],
    [
      "inference network",
      "setNetworkDrift",
      "Podman inference network identity or name changed after qualification.",
    ],
  ] as const)("rejects %s drift before mutation (#9608)", async (_authority, mutate, message) => {
    fixture = await createHermesPortableUninstallFixture(homeDir);
    fixture[mutate]();

    expect(() => runCleanup(fixture!)).toThrow(message);
    expect(fixture.sandboxDeleteCount()).toBe(0);
    expect(fixture.gatewayProvider.isPresent()).toBe(true);
    expect(fixture.harness.container()).not.toBeNull();
    expect(inspectHermesPortableUninstallJournal(fixture.stateDir)).toBeNull();
    expect(readHermesPortableLifecycleReceipt("portable-hermes", fixture.stateDir)).not.toBeNull();
    expect(fs.existsSync(fixture.unrelatedFile)).toBe(true);
  });

  it("rejects non-private inference state without repairing its mode (#9608)", async () => {
    fixture = await createHermesPortableUninstallFixture(homeDir);
    fs.chmodSync(fixture.inferenceDirectory, 0o755);

    expect(() => runCleanup(fixture!)).toThrow(
      "Hermes Portable inference gateway provider journal directory lacks private authority",
    );
    expect(fs.statSync(fixture.inferenceDirectory).mode & 0o777).toBe(0o755);
    expect(fixture.sandboxDeleteCount()).toBe(0);
    expect(inspectHermesPortableUninstallJournal(fixture.stateDir)).toBeNull();
  });

  it("rejects missing inference state without recreating it (#9608)", async () => {
    fixture = await createHermesPortableUninstallFixture(homeDir);
    fs.rmSync(fixture.inferenceDirectory, { recursive: true });

    expect(() => runCleanup(fixture!)).toThrow("authority directory is missing");
    expect(fs.existsSync(fixture.inferenceDirectory)).toBe(false);
    expect(fixture.sandboxDeleteCount()).toBe(0);
    expect(inspectHermesPortableUninstallJournal(fixture.stateDir)).toBeNull();
  });

  it("rejects provider absence that the prepared phase cannot justify (#9608)", async () => {
    fixture = await createHermesPortableUninstallFixture(homeDir, {
      interruptAfter: "prepared",
    });

    expect(() => runCleanup(fixture!)).toThrow("interrupted after prepared");
    fixture.gatewayProvider.setPresent(false);
    expect(() => runCleanup(fixture!)).toThrow(
      "gateway provider disappeared before uninstall journaled it",
    );
    expect(inspectHermesPortableUninstallJournal(fixture.stateDir)?.phase).toBe("prepared");
    expect(fixture.harness.container()).not.toBeNull();
    expect(readHermesPortableLifecycleReceipt("portable-hermes", fixture.stateDir)).not.toBeNull();
  });

  it.each(["prepared", "sandboxes-retired"] as const)(
    "rejects inference absence that the %s phase cannot justify (#9608)",
    async (phase) => {
      fixture = await createHermesPortableUninstallFixture(homeDir, { interruptAfter: phase });

      expect(() => runCleanup(fixture!)).toThrow(`interrupted after ${phase}`);
      const containerId = fixture.harness.container()!.id;
      expect(fixture.harness.engine.capture(["rm", "--force", containerId], 1_000).status).toBe(0);
      expect(() => runCleanup(fixture!)).toThrow(
        "Podman host-local inference container inspection failed",
      );
      expect(inspectHermesPortableUninstallJournal(fixture.stateDir)?.phase).toBe(phase);
      expect(
        readHermesPortableLifecycleReceipt("portable-hermes", fixture.stateDir),
      ).not.toBeNull();
    },
  );
});
