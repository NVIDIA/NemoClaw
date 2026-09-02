// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import { runSandboxProviderPreDeleteCleanup } from "../sandbox-provider-cleanup";
import {
  assertApfCreateIntent,
  completeHermesPortableSandboxRegistration,
  createProviderEffectBoundary,
  finalizeCreatedSandboxBeforeHermesCredentialReconciliation,
  hasManagedMcpRebuildHandoff,
  installPostCreateRecoveryRetryOwner,
  persistPostCreateRecovery,
  persistRetainedSandboxRecoveryMessage,
  readManagedDcodeCreateSelectionDrift,
  readSandboxRecreateRegistryEntry,
  reconcileCreatedHermesCredentialEnvironment,
  runAuthorityBoundProviderCleanup,
  runAsyncWithPostCreateRecovery,
  runSandboxCreateWithIdentityVerification,
  runWithPostCreateRecovery,
} from "./orchestration";

const UNVERIFIED_RECOVERY_CONTEXT = {
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  lifecycleGeneration: "generation-1",
  createAttemptNonce: "a".repeat(62),
} as const;

describe("created Hermes credential environment reconciliation", () => {
  const plan = { agent: "hermes" } as never;

  it("finalizes sandbox registration before reconciling credentials (#9833)", async () => {
    const events: string[] = [];

    await finalizeCreatedSandboxBeforeHermesCredentialReconciliation(
      async () => {
        events.push("registration:start");
        await Promise.resolve();
        events.push("registration:complete");
        return { sandboxName: "alpha" };
      },
      () => events.push("credentials:reconcile"),
    );

    expect(events).toEqual([
      "registration:start",
      "registration:complete",
      "credentials:reconcile",
    ]);
  });

  it("restarts and rechecks the managed gateway after changing the env file", () => {
    const events: string[] = [];
    const restart = { status: 0, stdout: "managed completion", stderr: "" };

    reconcileCreatedHermesCredentialEnvironment(
      { sandboxName: "alpha", plan },
      {
        revalidateSandboxIdentity: (operation) => events.push(`identity:${operation}`),
        reconcileCredentialEnv: () => {
          events.push("reconcile");
          return { changed: true };
        },
        restartGateway: () => {
          events.push("restart");
          return restart;
        },
        parseRestartCompletion: (result) => {
          events.push("parse");
          return result === restart ? {} : null;
        },
        waitForGateway: () => {
          events.push("wait");
          return true;
        },
      },
      vi.fn(),
    );

    expect(events).toEqual([
      expect.stringMatching(/^identity:reconciling/u),
      "reconcile",
      expect.stringMatching(/^identity:confirming/u),
      "restart",
      "parse",
      "wait",
      expect.stringMatching(/^identity:completing/u),
    ]);
  });

  it("does not restart when the env file was already reconciled", () => {
    const restartGateway = vi.fn();
    const waitForGateway = vi.fn();

    reconcileCreatedHermesCredentialEnvironment(
      { sandboxName: "alpha", plan },
      {
        revalidateSandboxIdentity: vi.fn(),
        reconcileCredentialEnv: () => ({ changed: false }),
        restartGateway,
        parseRestartCompletion: vi.fn(),
        waitForGateway,
      },
      vi.fn(),
    );

    expect(restartGateway).not.toHaveBeenCalled();
    expect(waitForGateway).not.toHaveBeenCalled();
  });

  it("refuses a same-name replacement at the credential mutation edge (#9833)", () => {
    const expectedIdentity = "identity-a";
    let liveIdentity = expectedIdentity;
    const mutations: string[] = [];
    const revalidateSandboxIdentity = vi.fn(() => {
      liveIdentity === expectedIdentity ||
        (() => {
          throw new Error("sandbox identity changed");
        })();
      liveIdentity = "identity-b";
    });

    expect(() =>
      reconcileCreatedHermesCredentialEnvironment(
        { sandboxName: "alpha", plan },
        {
          revalidateSandboxIdentity,
          reconcileCredentialEnv: ((_plan: never, revalidate?: (operation: string) => void) => {
            revalidate?.("mutating credential environment");
            mutations.push(liveIdentity);
            return { changed: true };
          }) as never,
          restartGateway: vi.fn(),
          parseRestartCompletion: vi.fn(),
          waitForGateway: vi.fn(),
        },
        vi.fn(),
      ),
    ).toThrow(/sandbox identity changed/u);
    expect(mutations).toEqual([]);
  });

  it("fails onboarding when the changed gateway cannot prove restart completion", () => {
    const recordRecovery = vi.fn();
    expect(() =>
      reconcileCreatedHermesCredentialEnvironment(
        { sandboxName: "alpha", plan },
        {
          revalidateSandboxIdentity: vi.fn(),
          reconcileCredentialEnv: () => ({ changed: true }),
          restartGateway: () => ({ status: 1, stdout: "", stderr: "failed" }),
          parseRestartCompletion: () => null,
          waitForGateway: vi.fn(),
        },
        recordRecovery,
      ),
    ).toThrow("managed gateway restart did not complete");
    expect(recordRecovery).toHaveBeenCalledOnce();
  });
});

describe("retained create recovery persistence", () => {
  it.each([
    ["available fingerprint", "f".repeat(64)],
    ["unavailable fingerprint", null],
  ])(
    "keeps the create-attempt authority after session sanitization with %s (#9211)",
    async (_case, fingerprint) => {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-recovery-"));
      const nonce = "a".repeat(62);
      const createAttemptLabel = `ai.nvidia.nemoclaw.create-attempt=${nonce}`;
      const message =
        `Create-attempt label: ${createAttemptLabel}. ` +
        `${fingerprint ? `Durable sandbox identity fingerprint: ${fingerprint}. ` : ""}` +
        "Recovery guidance follows after the authority fields. " +
        "x".repeat(400);

      try {
        vi.stubEnv("HOME", tempHome);
        vi.resetModules();
        const session = await import("../../state/onboard-session");
        session.saveSession(session.createSession({ sandboxName: "alpha" }));

        expect(
          persistRetainedSandboxRecoveryMessage(
            {
              sandboxName: "alpha",
              message,
              ...(fingerprint ? { sandboxIdentityFingerprint: fingerprint } : {}),
              recoveryContext: UNVERIFIED_RECOVERY_CONTEXT,
            },
            session.markRetainedSandboxRecovery,
          ),
        ).toBe(true);

        const stored = session.loadSession();
        expect(stored?.status).toBe("recovery_required");
        expect(stored?.resumable).toBe(false);
        expect(stored?.cancellationRecovery?.reason).toBe(
          "retained_after_sandbox_creation_failure",
        );
        expect(stored?.cancellationRecovery?.sandboxName).toBe("alpha");
        expect(stored?.machine.state).not.toBe("failed");
        expect(stored?.steps.sandbox?.status).not.toBe("failed");
        expect(stored?.failure?.message).toContain(createAttemptLabel);
        expect(stored?.steps.sandbox?.error).toContain(createAttemptLabel);
        const fingerprintExpectation = fingerprint
          ? expect.stringContaining(fingerprint)
          : expect.not.stringContaining("Durable sandbox identity fingerprint:");
        expect(stored?.failure?.message).toEqual(fingerprintExpectation);
        expect(stored?.steps.sandbox?.error).toEqual(fingerprintExpectation);
      } finally {
        vi.resetModules();
        fs.rmSync(tempHome, { force: true, recursive: true });
        vi.unstubAllEnvs();
      }
    },
  );

  it("forwards the full verified recovery tuple to durable state (#9833)", () => {
    const recoveryContext = {
      gatewayName: "nemoclaw-18080",
      gatewayPort: 18080,
      lifecycleGeneration: "00000000-0000-4000-8000-000000000004",
      createAttemptNonce: "b".repeat(62),
    } as const;
    const markRetainedSandboxRecovery = vi.fn(() => true);
    const input = {
      stage: "registry publication" as const,
      sandboxName: "alpha",
      gatewayName: recoveryContext.gatewayName,
      lifecycleGeneration: recoveryContext.lifecycleGeneration,
      exactIdentity: "f".repeat(64),
      recoveryContext,
      markRetainedSandboxRecovery,
    };

    persistPostCreateRecovery(input);

    expect(markRetainedSandboxRecovery).toHaveBeenCalledWith(
      "alpha",
      expect.stringContaining(recoveryContext.lifecycleGeneration),
      "f".repeat(64),
      recoveryContext,
    );
  });

  it("reports persistence failure when no onboard session owns the recovery (#9211)", () => {
    const finalizeIncompleteOnboardStep = vi.fn(() => null);

    expect(
      persistRetainedSandboxRecoveryMessage(
        {
          sandboxName: "alpha",
          message: "Create-attempt label: ai.nvidia.nemoclaw.create-attempt=authority",
          recoveryContext: UNVERIFIED_RECOVERY_CONTEXT,
        },
        finalizeIncompleteOnboardStep,
      ),
    ).toBe(false);
    expect(finalizeIncompleteOnboardStep).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      "Create-attempt label: ai.nvidia.nemoclaw.create-attempt=authority",
      undefined,
      UNVERIFIED_RECOVERY_CONTEXT,
    );
  });

  it("reports persistence failure when the onboard session is already terminal (#9211)", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-recovery-"));

    try {
      vi.stubEnv("HOME", tempHome);
      vi.resetModules();
      const session = await import("../../state/onboard-session");
      session.saveSession(session.createSession({ sandboxName: "alpha" }));
      session.finalizeIncompleteOnboardStep("sandbox", "Earlier sandbox failure");

      expect(
        persistRetainedSandboxRecoveryMessage(
          {
            sandboxName: "alpha",
            message: "Create-attempt label: ai.nvidia.nemoclaw.create-attempt=unpersisted",
            recoveryContext: UNVERIFIED_RECOVERY_CONTEXT,
          },
          session.markRetainedSandboxRecovery,
        ),
      ).toBe(true);

      const stored = session.loadSession();
      expect(stored?.status).toBe("recovery_required");
      expect(stored?.failure?.message).toContain("create-attempt=unpersisted");
      expect(stored?.steps.sandbox?.error).toContain("create-attempt=unpersisted");
    } finally {
      vi.resetModules();
      fs.rmSync(tempHome, { force: true, recursive: true });
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["registry publication", "false"],
    ["registry publication", "throw"],
    ["registry publication", "journal readback mismatch"],
    ["onboarding finalization", "false"],
    ["onboarding finalization", "throw"],
    ["onboarding finalization", "journal readback mismatch"],
  ] as const)(
    "keeps the original %s error when recovery persistence returns %s (#9833)",
    async (stage, failureMode) => {
      const operationError = new Error(`${stage} failed`);
      const recoveryFailures = {
        false: () => false,
        throw: () => {
          throw new Error("retained sandbox recovery writer threw");
        },
        "journal readback mismatch": () => {
          throw new Error("Retained sandbox recovery record did not survive durable readback.");
        },
      } satisfies Record<typeof failureMode, () => false | never>;
      const markRetainedSandboxRecovery = vi.fn(recoveryFailures[failureMode]);
      const recordRecovery = () =>
        persistPostCreateRecovery({
          stage,
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          lifecycleGeneration: "generation-1",
          exactIdentity: "f".repeat(64),
          recoveryContext: UNVERIFIED_RECOVERY_CONTEXT,
          markRetainedSandboxRecovery,
        });

      const caught =
        stage === "registry publication"
          ? await runAsyncWithPostCreateRecovery(
              async () => Promise.reject(operationError),
              recordRecovery,
            ).catch((error: unknown) => error)
          : (() => {
              try {
                return runWithPostCreateRecovery(() => {
                  throw operationError;
                }, recordRecovery);
              } catch (error) {
                return error;
              }
            })();

      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toEqual(
        expect.arrayContaining([
          operationError,
          expect.objectContaining({
            message: expect.stringContaining("could not save the retained sandbox recovery"),
          }),
        ]),
      );
      expect(((caught as AggregateError).errors[1] as Error).cause).toEqual(
        failureMode === "false"
          ? undefined
          : expect.objectContaining({
              message: expect.stringMatching(/writer threw|did not survive durable readback/u),
            }),
      );
    },
  );

  it.each(["registry publication", "onboarding finalization"] as const)(
    "retries %s recovery at exit without rerunning the failed operation (#9833)",
    async (stage) => {
      const exitHandlers: Array<() => void> = [];
      const owner = installPostCreateRecoveryRetryOwner({
        log: vi.fn(),
        registerExitHandler: (handler) => exitHandlers.push(handler),
      });
      const operationError = new Error(`${stage} failed`);
      const operation = vi.fn(() => {
        throw operationError;
      });
      const recordRecovery = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("retained recovery write failed");
        })
        .mockImplementationOnce(() => undefined);
      const recordWithOwner = () => owner.record(recordRecovery);

      const caught =
        stage === "registry publication"
          ? await runAsyncWithPostCreateRecovery(async () => operation(), recordWithOwner).catch(
              (error: unknown) => error,
            )
          : (() => {
              try {
                return runWithPostCreateRecovery(operation, recordWithOwner);
              } catch (error) {
                return error;
              }
            })();

      expect(caught).toBeInstanceOf(AggregateError);
      expect(operation).toHaveBeenCalledOnce();
      expect(recordRecovery).toHaveBeenCalledOnce();

      exitHandlers[0]();
      expect(recordRecovery).toHaveBeenCalledTimes(2);
      expect(operation).toHaveBeenCalledOnce();

      exitHandlers[0]();
      expect(recordRecovery).toHaveBeenCalledTimes(2);
    },
  );
});

describe("APF create policy selection", () => {
  it("requires APF effects to use the generic post-create gate (#9833)", () => {
    expect(() =>
      assertApfCreateIntent({
        apfInterceptorRequested: true,
      }),
    ).toThrow(/missing deferred-effect authority/u);
    expect(() =>
      assertApfCreateIntent({
        apfInterceptorRequested: true,
        deferSandboxEffectsUntilIdentityVerification: true,
      }),
    ).not.toThrow();
    expect(() => assertApfCreateIntent(null)).not.toThrow();
  });
});

describe("deferred provider effect authority", () => {
  it("carries identity authority through every provider cleanup effect (#9833)", () => {
    let liveIdentity = "identity-a";
    const operations: string[] = [];
    const revalidateSandboxIdentity = vi.fn((operation: string) => {
      operations.push(operation);
      liveIdentity === "identity-a" ||
        (() => {
          throw new Error("sandbox identity changed");
        })();
    });
    const runProviderPreDeleteCleanup = vi.fn((_sandboxName, deps) => {
      expect(deps.revalidateSandboxIdentity).toBe(revalidateSandboxIdentity);
      deps.revalidateSandboxIdentity?.("detaching provider");
      liveIdentity = "identity-b";
      deps.revalidateSandboxIdentity?.("confirming provider detach");
      return { detached: [], failures: [] };
    });

    expect(() =>
      runAuthorityBoundProviderCleanup({
        sandboxName: "alpha",
        revalidateSandboxIdentity,
        runProviderPreDeleteCleanup,
        runOpenshell: vi.fn(),
        redact: (value) => value,
      }),
    ).toThrow(/sandbox identity changed/u);
    expect(runProviderPreDeleteCleanup).toHaveBeenCalledOnce();
    expect(operations).toEqual([
      "cleaning up providers for sandbox 'alpha'",
      "detaching provider",
      "confirming provider detach",
    ]);
  });

  it("refuses provider cleanup when a sandbox appears after verified absence (#9833)", () => {
    let observationCount = 0;
    const revalidateSandboxIdentity = vi.fn();
    const runOpenshell = vi.fn(() => ({
      pid: 1,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    }));

    expect(() =>
      runAuthorityBoundProviderCleanup({
        sandboxName: "alpha",
        observeSandbox: () =>
          observationCount++ === 0
            ? { state: "missing", liveIdentityFingerprint: null }
            : { state: "ready", liveIdentityFingerprint: "f".repeat(64) },
        revalidateSandboxIdentity,
        runProviderPreDeleteCleanup: runSandboxProviderPreDeleteCleanup,
        runOpenshell,
        redact: (value) => value,
        tolerateMissingSandbox: true,
      }),
    ).toThrow(/appeared after absence was verified/u);
    expect(revalidateSandboxIdentity).toHaveBeenCalledOnce();
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("refuses every deferred provider attachment before a same-name replacement can receive credentials (#9833)", async () => {
    const revalidateSandboxIdentity = vi.fn();
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const boundary = createProviderEffectBoundary({
      deferred: true,
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      preparationInput: {
        openshellDriver: "docker",
        inferenceProvider: null,
        messagingProviders: [],
        messagingProviderRequests: [],
        extraProviders: [],
        gatewayName: "nemoclaw",
      },
      preparationDeps: {
        runOpenshell: runOpenshell as never,
        cleanupCreateSources: vi.fn(),
      },
      runVerifiedSandboxCreateEffects: null,
      activateDeferredProviderEffects: (revalidate) => {
        revalidate("cleaning up providers for sandbox 'alpha'");
        return ["first", "second"];
      },
      revalidateSandboxIdentityBeforeCreate: vi.fn(),
    });
    const runAfterVerifiedCreate = boundary.runAfterVerifiedCreate;
    expect(runAfterVerifiedCreate).toBeTypeOf("function");

    const error = await runAfterVerifiedCreate!({
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      gatewayPort: 18790,
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: "a".repeat(64),
      route: "direct" as never,
      revalidateSandboxIdentity,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Do not delete it by mutable sandbox name. Ask an OpenShell administrator to remove the retained sandbox through an identity-bound procedure.",
    );
    expect((error as Error).message).toContain(
      "After OpenShell confirms the retained sandbox is absent, run 'nemoclaw alpha destroy --yes' to reconcile its verified Docker containers and recovery record.",
    );

    expect(runOpenshell).not.toHaveBeenCalledWith(
      expect.arrayContaining(["sandbox", "provider", "attach"]),
      expect.anything(),
    );
    expect(revalidateSandboxIdentity).toHaveBeenCalledWith(
      "attaching deferred providers to sandbox 'alpha'",
    );
  });

  it("completes deferred provider effects when no attachment remains (#9833)", async () => {
    const revalidateSandboxIdentity = vi.fn();
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const boundary = createProviderEffectBoundary({
      deferred: true,
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      preparationInput: {
        openshellDriver: "docker",
        inferenceProvider: null,
        messagingProviders: [],
        messagingProviderRequests: [],
        extraProviders: [],
        gatewayName: "nemoclaw",
      },
      preparationDeps: {
        runOpenshell: runOpenshell as never,
        cleanupCreateSources: vi.fn(),
      },
      runVerifiedSandboxCreateEffects: null,
      activateDeferredProviderEffects: () => [],
      revalidateSandboxIdentityBeforeCreate: vi.fn(),
    });
    const runAfterVerifiedCreate = boundary.runAfterVerifiedCreate;
    expect(runAfterVerifiedCreate).toBeTypeOf("function");

    await expect(
      runAfterVerifiedCreate?.({
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        gatewayPort: 18790,
        lifecycleGeneration: "generation-1",
        lifecycleLiveIdentityFingerprint: "a".repeat(64),
        route: "direct" as never,
        revalidateSandboxIdentity,
      }),
    ).resolves.toBeUndefined();

    expect(runOpenshell).not.toHaveBeenCalledWith(
      expect.arrayContaining(["sandbox", "provider", "attach"]),
      expect.anything(),
    );
    expect(revalidateSandboxIdentity).toHaveBeenCalledWith(
      "attaching deferred providers to sandbox 'alpha'",
    );
  });
});

describe("managed MCP rebuild handoff", () => {
  const targetIntentFingerprint = "a".repeat(64);
  const recreateTransaction = {
    id: "recreate-1",
    targetGeneration: "generation-1",
    targetIntentFingerprint,
  };

  it("accepts only a handoff bound to the same recreate transaction", () => {
    expect(
      hasManagedMcpRebuildHandoff({
        recreate: true,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
        recreateJournalTargetIntentFingerprint: targetIntentFingerprint,
        recreateTransaction,
      }),
    ).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["mismatched", "b".repeat(64)],
  ])("rejects a %s outer rebuild handoff", (_label, handoff) => {
    expect(
      hasManagedMcpRebuildHandoff({
        recreate: true,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
        ...(handoff ? { recreateJournalTargetIntentFingerprint: handoff } : {}),
        recreateTransaction,
      }),
    ).toBe(false);
  });
});

describe("sandbox recreate registry authority", () => {
  it("re-reads the durable source row for Hermes portable recreation (#10056)", () => {
    const durable = { name: "alpha", lifecycleGeneration: "source-generation" } as SandboxEntry;
    const readRegistry = vi.fn(() => durable);

    expect(
      readSandboxRecreateRegistryEntry({
        sandboxName: "alpha",
        recreateTransaction: true,
        existingEntry: null,
        readRegistry,
      }),
    ).toBe(durable);
    expect(readRegistry).toHaveBeenCalledExactlyOnceWith("alpha");
  });

  it("keeps the inspected entry when no recreate transaction exists", () => {
    const inspected = { name: "alpha" } as SandboxEntry;
    const readRegistry = vi.fn(() => null);

    expect(
      readSandboxRecreateRegistryEntry({
        sandboxName: "alpha",
        recreateTransaction: false,
        existingEntry: inspected,
        readRegistry,
      }),
    ).toBe(inspected);
    expect(readRegistry).not.toHaveBeenCalled();
  });
});

describe("managed DCode sandbox create selection", () => {
  it.each([null, "https://openrouter.ai/api/v1"])(
    "passes the selected endpoint to live drift validation: %s (#9555)",
    (endpointUrl) => {
      const readDcodeSelectionDrift = vi.fn(() => ({
        changed: false,
        providerChanged: false,
        modelChanged: false,
        existingProvider: "openrouter",
        existingModel: "openrouter:nvidia/nemotron-3-ultra-550b-a55b",
        unknown: false,
      }));

      readManagedDcodeCreateSelectionDrift(
        {
          sandboxName: "saved",
          provider: "compatible-endpoint",
          model: "nvidia/nemotron-3-ultra-550b-a55b",
          preferredInferenceApi: "openai-completions",
          createIntent: { endpointUrl },
        },
        readDcodeSelectionDrift,
      );

      expect(readDcodeSelectionDrift).toHaveBeenCalledWith(
        "saved",
        "compatible-endpoint",
        "nvidia/nemotron-3-ultra-550b-a55b",
        "openai-completions",
        endpointUrl,
      );
    },
  );
});

describe("Hermes portable registration adapter", () => {
  it("returns the durable normalized registry entry after registration (#9211)", async () => {
    const events: string[] = [];
    const raw = { name: "alpha", dashboardPort: 0 } as SandboxEntry;
    const durable = { name: "alpha", dashboardPort: null } as SandboxEntry;
    const completeRegistration = vi.fn(async () => {
      events.push("complete");
      return raw;
    });
    const readRegistry = vi.fn(() => {
      events.push("read");
      return durable;
    });

    await expect(
      completeHermesPortableSandboxRegistration({
        sandboxName: "alpha",
        completeRegistration,
        readRegistry,
      }),
    ).resolves.toBe(durable);
    expect(completeRegistration).toHaveBeenCalledOnce();
    expect(readRegistry).toHaveBeenCalledExactlyOnceWith("alpha");
    expect(events).toEqual(["complete", "read"]);
  });

  it("rejects a missing durable registry entry after registration (#9211)", async () => {
    const completeRegistration = vi.fn(async () => undefined);
    const readRegistry = vi.fn(() => null);

    await expect(
      completeHermesPortableSandboxRegistration({
        sandboxName: "alpha",
        completeRegistration,
        readRegistry,
      }),
    ).rejects.toThrow("Hermes portable sandbox registration returned no authority");
    expect(completeRegistration).toHaveBeenCalledOnce();
    expect(readRegistry).toHaveBeenCalledExactlyOnceWith("alpha");
  });
});

describe("sandbox create identity checks", () => {
  const exactIdentity = "a".repeat(64);
  const verifiedCreateBoundary = () => ({
    captureVerifiedCreateBoundary: vi.fn(() => "verified"),
    persistCreateIdentity: vi.fn(),
    revalidateVerifiedCreateIdentity: vi.fn(),
  });
  const exactIdentityBoundary = () => ({
    captureCreatedSandboxIdentity: vi.fn(() => exactIdentity),
    persistCreatedSandboxIdentity: vi.fn(),
    revalidateCreatedSandboxIdentity: vi.fn(),
    ...verifiedCreateBoundary(),
  });

  it("refuses sandbox creation before mutation when the final check fails (#9833)", async () => {
    const create = vi.fn(async () => "created");

    await expect(
      runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate: () => {
          throw new Error("create boundary changed before the selected route");
        },
        ...exactIdentityBoundary(),
        create,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow(/create boundary changed before/u);
    expect(create).not.toHaveBeenCalled();
  });

  it("checks the named Ready sandbox before registration can continue (#9833)", async () => {
    const events: string[] = [];
    const result = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate: (sandboxIsLive) => events.push(sandboxIsLive ? "ready-check" : "create-check"),
      create: async (verifyCreatedSandbox) => {
        events.push("create");
        await verifyCreatedSandbox("created");
        return "created";
      },
      captureCreatedSandboxIdentity: () => {
        events.push("capture-identity");
        return exactIdentity;
      },
      persistCreatedSandboxIdentity: () => events.push("persist-identity"),
      revalidateCreatedSandboxIdentity: () => events.push("identity-check"),
      captureVerifiedCreateBoundary: () => {
        events.push("boundary-check");
        return "verified";
      },
      persistCreateIdentity: () => events.push("persist-checkpoint"),
      revalidateVerifiedCreateIdentity: () => events.push("revalidate-checkpoint"),
      cleanupTemporarySources: vi.fn(),
    });
    events.push("register");

    expect(result).toBe("created");
    expect(events).toEqual([
      "create-check",
      "create",
      "capture-identity",
      "persist-identity",
      "identity-check",
      "boundary-check",
      "identity-check",
      "persist-checkpoint",
      "revalidate-checkpoint",
      "identity-check",
      "identity-check",
      "register",
    ]);
  });

  it("removes temporary sources but preserves the sandbox after final identity failure (#9833)", async () => {
    const events: string[] = [];
    const createAttemptNonce = "c".repeat(62);
    const revalidate = vi.fn(() => events.push("create-check"));

    const error = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate,
      create: async (verifyCreatedSandbox) => {
        events.push("create");
        await verifyCreatedSandbox("created");
        return "created";
      },
      ...exactIdentityBoundary(),
      captureCreatedSandboxCreateAttemptNonce: () => createAttemptNonce,
      revalidateVerifiedCreateIdentity: () => {
        events.push("ready-check");
        throw new Error("sandbox identity changed");
      },
      cleanupTemporarySources: () => events.push("cleanup-sources"),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toMatch(
      new RegExp(
        `Create-attempt label: ai\\.nvidia\\.nemoclaw\\.create-attempt=${createAttemptNonce}.*left sandbox 'alpha' in place.*identity fingerprint: ${exactIdentity}.*did not run OpenShell's mutable-name deletion command.*Do not delete the sandbox by mutable sandbox name.*OpenShell administrator.*identity-bound recovery or removal procedure`,
        "u",
      ),
    );
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(
            new RegExp(
              `Create-attempt label: ai\\.nvidia\\.nemoclaw\\.create-attempt=${createAttemptNonce}.*left sandbox 'alpha' in place.*identity fingerprint: ${exactIdentity}.*did not run OpenShell's mutable-name deletion command.*Do not delete the sandbox by mutable sandbox name.*OpenShell administrator.*identity-bound recovery or removal procedure`,
              "u",
            ),
          ),
        }),
      ]),
    );
    expect(events).toEqual(["create-check", "create", "ready-check", "cleanup-sources"]);
  });

  it("records recovery before returning a post-create identity failure (#9833)", async () => {
    const persistRetainedSandboxRecovery = vi.fn(() => true);

    await expect(
      runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          return "created";
        },
        ...exactIdentityBoundary(),
        revalidateVerifiedCreateIdentity: () => {
          throw new Error("sandbox identity changed");
        },
        persistRetainedSandboxRecovery,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(persistRetainedSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("left sandbox 'alpha' in place"),
      exactIdentity,
      "verified",
      "created",
    );
  });

  it("retains the exact create identity when checkpoint persistence fails (#9833)", async () => {
    const verifiedEvidence = { lifecycleGeneration: "generation-4" } as const;
    const persistRetainedSandboxRecovery = vi.fn(() => true);

    await expect(
      runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          return "created";
        },
        ...exactIdentityBoundary(),
        captureVerifiedCreateBoundary: () => verifiedEvidence,
        persistCreateIdentity: () => {
          throw new Error("checkpoint write failed");
        },
        persistRetainedSandboxRecovery,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(persistRetainedSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("left sandbox 'alpha' in place"),
      exactIdentity,
      verifiedEvidence,
      "created",
    );
  });

  it("records recovery when the create runner fails after verification (#9833)", async () => {
    const createFailure = new Error("runtime patch failed after verification");
    const persistRetainedSandboxRecovery = vi.fn(() => true);

    const error = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate: vi.fn(),
      create: async (verifyCreatedSandbox) => {
        await verifyCreatedSandbox("created");
        throw createFailure;
      },
      ...exactIdentityBoundary(),
      persistRetainedSandboxRecovery,
      cleanupTemporarySources: vi.fn(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toContain(createFailure);
    expect((error as AggregateError).message).toContain(
      "post-create verification or finalization failed",
    );
    expect(persistRetainedSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("left sandbox 'alpha' in place"),
      exactIdentity,
      "verified",
      "created",
    );
  });

  it.each(["false", "throw", "journal readback mismatch"] as const)(
    "retries create-runner recovery when its durable writer returns %s (#9833)",
    async (failureMode) => {
      const exitHandlers: Array<() => void> = [];
      const retryOwner = installPostCreateRecoveryRetryOwner({
        log: vi.fn(),
        registerExitHandler: (handler) => exitHandlers.push(handler),
      });
      const createFailure = new Error("runtime patch failed after verification");
      const writerFailures = {
        false: () => false,
        throw: () => {
          throw new Error("retained recovery writer threw");
        },
        "journal readback mismatch": () => {
          throw new Error("Retained sandbox recovery record did not survive durable readback.");
        },
      } satisfies Record<typeof failureMode, () => boolean>;
      const writer = vi
        .fn()
        .mockImplementationOnce(writerFailures[failureMode])
        .mockReturnValue(true);
      const create = vi.fn(async (verifyCreatedSandbox: (created: string) => Promise<string>) => {
        await verifyCreatedSandbox("created");
        throw createFailure;
      });

      const error = await runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create,
        ...exactIdentityBoundary(),
        persistRetainedSandboxRecovery: writer,
        retainedSandboxRecoveryRetryOwner: retryOwner,
        cleanupTemporarySources: vi.fn(),
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AggregateError);
      expect(writer).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledOnce();

      exitHandlers[0]();
      expect(writer).toHaveBeenCalledTimes(2);
      expect(create).toHaveBeenCalledOnce();

      exitHandlers[0]();
      expect(writer).toHaveBeenCalledTimes(2);
    },
  );

  it("does not delete a same-name replacement after final identity failure (#9833)", async () => {
    let sandboxIdentity = "created";
    const revalidate = vi.fn();
    const revalidateCreatedSandboxIdentity = vi.fn();

    const error = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate,
      create: async (verifyCreatedSandbox) => {
        await verifyCreatedSandbox("created");
        return "created";
      },
      captureCreatedSandboxIdentity: () => exactIdentity,
      persistCreatedSandboxIdentity: vi.fn(),
      revalidateCreatedSandboxIdentity,
      ...verifiedCreateBoundary(),
      revalidateVerifiedCreateIdentity: () => {
        sandboxIdentity = "replacement";
        throw new Error("sandbox identity changed");
      },
      cleanupTemporarySources: vi.fn(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(
            new RegExp(
              `left sandbox 'alpha' in place.*identity fingerprint: ${exactIdentity}.*Do not delete the sandbox by mutable sandbox name`,
              "u",
            ),
          ),
        }),
      ]),
    );
    expect(revalidateCreatedSandboxIdentity).toHaveBeenNthCalledWith(
      1,
      exactIdentity,
      "verifying created sandbox 'alpha'",
    );
    expect(revalidateCreatedSandboxIdentity).toHaveBeenNthCalledWith(
      2,
      exactIdentity,
      "recording pending create identity for sandbox 'alpha'",
    );
    expect(sandboxIdentity).toBe("replacement");
  });

  it("retains the durable checkpoint when identity-bound provider attachment is unavailable (#9833)", async () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const checkpoint = { state: "absent" };
    const providerBoundary = createProviderEffectBoundary({
      deferred: true,
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      preparationInput: {
        openshellDriver: "kubernetes",
        inferenceProvider: null,
        messagingProviders: [],
        messagingProviderRequests: [],
        extraProviders: [],
        gatewayName: "nemoclaw",
      },
      preparationDeps: {
        runOpenshell: runOpenshell as never,
        cleanupCreateSources: vi.fn(),
      },
      runVerifiedSandboxCreateEffects: null,
      activateDeferredProviderEffects: () => ["credential-provider"],
      revalidateSandboxIdentityBeforeCreate: vi.fn(),
    });
    const error = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate: vi.fn(),
      create: async (verifyCreatedSandbox) => {
        await verifyCreatedSandbox("created");
        return "created";
      },
      ...exactIdentityBoundary(),
      persistCreateIdentity: () => {
        checkpoint.state = "verified-create";
      },
      runVerifiedCreateEffects: async () => {
        await providerBoundary.runAfterVerifiedCreate?.({
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          lifecycleGeneration: "00000000-0000-4000-8000-000000000001",
          lifecycleLiveIdentityFingerprint: exactIdentity,
          route: "none",
          revalidateSandboxIdentity: vi.fn(),
        });
      },
      cleanupTemporarySources: vi.fn(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect(checkpoint.state).toBe("verified-create");
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("reports temporary source cleanup failure with sandbox preservation (#9833)", async () => {
    const revalidate = vi.fn();

    const error = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate,
      create: async (verifyCreatedSandbox) => {
        await verifyCreatedSandbox("created");
        return "created";
      },
      ...exactIdentityBoundary(),
      revalidateVerifiedCreateIdentity: () => {
        throw new Error("sandbox identity changed");
      },
      cleanupTemporarySources: () => {
        throw new Error("temporary source cleanup failed");
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "temporary source cleanup failed" }),
        expect.objectContaining({ message: expect.stringContaining("left sandbox 'alpha'") }),
      ]),
    );
  });

  it("runs continuation effects only after identity verification (#9833)", async () => {
    const events: string[] = [];

    const result = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate: (sandboxIsLive) => events.push(sandboxIsLive ? "identity" : "preflight"),
      create: async (verifyCreatedSandbox) => {
        events.push("create");
        await verifyCreatedSandbox({ sandboxName: "alpha" });
        return "complete";
      },
      runVerifiedCreateEffects: async () => {
        events.push("provider-effects");
      },
      captureCreatedSandboxIdentity: () => {
        events.push("capture");
        return exactIdentity;
      },
      persistCreatedSandboxIdentity: () => events.push("persist-identity"),
      revalidateCreatedSandboxIdentity: () => events.push("identity"),
      captureVerifiedCreateBoundary: () => {
        events.push("boundary");
        return "verified";
      },
      persistCreateIdentity: () => events.push("checkpoint"),
      revalidateVerifiedCreateIdentity: () => events.push("checkpoint-revalidate"),
      cleanupTemporarySources: vi.fn(),
    });

    expect(result).toBe("complete");
    expect(events).toEqual([
      "preflight",
      "create",
      "capture",
      "persist-identity",
      "identity",
      "boundary",
      "identity",
      "checkpoint",
      "checkpoint-revalidate",
      "provider-effects",
      "identity",
      "identity",
    ]);
  });

  it("withholds checkpoint and effects when post-create boundary capture fails (#9833)", async () => {
    const persistCreateIdentity = vi.fn();
    const runVerifiedCreateEffects = vi.fn();

    const error = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate: vi.fn(),
      create: async (verifyCreatedSandbox) => {
        await verifyCreatedSandbox("created");
        return "created";
      },
      captureCreatedSandboxIdentity: () => exactIdentity,
      persistCreatedSandboxIdentity: vi.fn(),
      revalidateCreatedSandboxIdentity: vi.fn(),
      captureVerifiedCreateBoundary: () => {
        throw new Error("identity boundary capture failed");
      },
      persistCreateIdentity,
      revalidateVerifiedCreateIdentity: vi.fn(),
      runVerifiedCreateEffects,
      cleanupTemporarySources: vi.fn(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "identity boundary capture failed" }),
      ]),
    );
    expect(persistCreateIdentity).not.toHaveBeenCalled();
    expect(runVerifiedCreateEffects).not.toHaveBeenCalled();
  });

  it("withholds effects when durable checkpoint persistence fails (#9833)", async () => {
    const revalidateVerifiedCreateIdentity = vi.fn();
    const runVerifiedCreateEffects = vi.fn();

    await expect(
      runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          return "created";
        },
        captureCreatedSandboxIdentity: () => exactIdentity,
        persistCreatedSandboxIdentity: vi.fn(),
        revalidateCreatedSandboxIdentity: vi.fn(),
        captureVerifiedCreateBoundary: () => "verified",
        persistCreateIdentity: () => {
          throw new Error("checkpoint persistence failed");
        },
        revalidateVerifiedCreateIdentity,
        runVerifiedCreateEffects,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(revalidateVerifiedCreateIdentity).not.toHaveBeenCalled();
    expect(runVerifiedCreateEffects).not.toHaveBeenCalled();
  });

  it("retains the checkpoint and withholds effects when its reread fails (#9833)", async () => {
    const persistCreateIdentity = vi.fn();
    const runVerifiedCreateEffects = vi.fn();

    await expect(
      runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          return "created";
        },
        captureCreatedSandboxIdentity: () => exactIdentity,
        persistCreatedSandboxIdentity: vi.fn(),
        revalidateCreatedSandboxIdentity: vi.fn(),
        captureVerifiedCreateBoundary: () => "verified",
        persistCreateIdentity,
        revalidateVerifiedCreateIdentity: () => {
          throw new Error("durable checkpoint missing");
        },
        runVerifiedCreateEffects,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(persistCreateIdentity).toHaveBeenCalledOnce();
    expect(runVerifiedCreateEffects).not.toHaveBeenCalled();
  });

  it("retains the durable checkpoint when a deferred effect fails (#9833)", async () => {
    const persistCreateIdentity = vi.fn();

    await expect(
      runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          return "created";
        },
        captureCreatedSandboxIdentity: () => exactIdentity,
        persistCreatedSandboxIdentity: vi.fn(),
        revalidateCreatedSandboxIdentity: vi.fn(),
        captureVerifiedCreateBoundary: () => "verified",
        persistCreateIdentity,
        revalidateVerifiedCreateIdentity: vi.fn(),
        runVerifiedCreateEffects: async () => {
          throw new Error("provider effect failed");
        },
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(persistCreateIdentity).toHaveBeenCalledOnce();
  });

  it("refuses continuation when identity changes during boundary capture (#9833)", async () => {
    const continuationEffect = vi.fn();
    const persistRetainedSandboxRecovery = vi.fn(() => true);
    const revalidate = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined);
    const revalidateCreatedSandboxIdentity = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("sandbox identity changed");
      });

    await expect(
      runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate,
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          continuationEffect();
          return "created";
        },
        captureCreatedSandboxIdentity: () => exactIdentity,
        persistCreatedSandboxIdentity: vi.fn(),
        revalidateCreatedSandboxIdentity,
        ...verifiedCreateBoundary(),
        persistRetainedSandboxRecovery,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(continuationEffect).not.toHaveBeenCalled();
    expect(persistRetainedSandboxRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("left sandbox 'alpha' in place"),
      exactIdentity,
      null,
      "created",
    );
  });

  it("stops before boundary capture when the exact identity cannot be persisted (#9833)", async () => {
    const revalidateCreatedSandboxIdentity = vi.fn();
    const captureVerifiedCreateBoundary = vi.fn();
    const persistCreateIdentity = vi.fn();
    const runVerifiedCreateEffects = vi.fn();

    await expect(
      runSandboxCreateWithIdentityVerification({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          return "created";
        },
        captureCreatedSandboxIdentity: () => exactIdentity,
        persistCreatedSandboxIdentity: () => {
          throw new Error("durable identity journal unavailable");
        },
        revalidateCreatedSandboxIdentity,
        captureVerifiedCreateBoundary,
        persistCreateIdentity,
        revalidateVerifiedCreateIdentity: vi.fn(),
        runVerifiedCreateEffects,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(revalidateCreatedSandboxIdentity).not.toHaveBeenCalled();
    expect(captureVerifiedCreateBoundary).not.toHaveBeenCalled();
    expect(persistCreateIdentity).not.toHaveBeenCalled();
    expect(runVerifiedCreateEffects).not.toHaveBeenCalled();
  });

  it("fails closed when a create implementation skips the post-create gate (#9833)", async () => {
    const cleanupTemporarySources = vi.fn();

    const error = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate: vi.fn(),
      create: async () => "created",
      ...exactIdentityBoundary(),
      cleanupTemporarySources,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toMatch(
      /left sandbox 'alpha' in place.*did not return a durable sandbox identity fingerprint.*Do not delete the sandbox by mutable sandbox name.*identity-bound recovery or removal procedure/u,
    );
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("post-create verification") }),
      ]),
    );
    expect(cleanupTemporarySources).toHaveBeenCalledOnce();
  });
});
