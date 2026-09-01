// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry/types";
import {
  normalizeHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
  type HostLocalInferencePreparedStartup,
  type HostLocalInferenceReceipt,
} from "../runtime-provider/host-local-inference";
import type { HostLocalInferenceStartupRequest } from "../runtime-provider/host-local-inference-routing";
import {
  HermesPortableOllamaRecoveryError,
  HermesPortableOllamaRecoveryPhaseError,
  inspectHermesPortableOllamaReadinessRuntime,
  recoverHermesPortableOllamaInference,
  rethrowHermesPortableOllamaRegistryRecoveryError,
} from "./hermes-portable-ollama-inference";
import {
  PortableRegistryRecoveryPhaseError,
  PortableRegistryRecoveryRestorationError,
} from "./hermes-portable-ollama-authority";

const GPU_DEVICE = "nvidia.com/gpu=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function publishedReceipt(): HostLocalInferenceReceipt {
  return normalizeHostLocalInferenceReceipt({
    schemaVersion: 2,
    providerId: "podman",
    service: "ollama",
    engineAuthority: {
      schemaVersion: 1,
      providerId: "podman",
      operation: "host-local-inference",
      engineId: "podman",
      authorityId: `podman-endpoint:${"a".repeat(64)}`,
      bindingSha256: "b".repeat(64),
    },
    endpoint: {
      host: "host.openshell.internal",
      port: 11_434,
      networkName: "openshell-docker",
      networkId: "c".repeat(64),
      networkGatewayIp: "10.89.0.1",
      networkListenerIp: "10.89.0.2",
      networkAuthoritySha256: "d".repeat(64),
    },
    inference: {
      protocol: "openai-chat-completions",
      model: "qwen3-vl:4b",
      toolCallingRequired: true,
    },
    publication: {
      transactionId: "e".repeat(64),
      targetSha256: "f".repeat(64),
      priorState: "absent",
    },
    runtime: {
      kind: "container",
      runtimeId: "a".repeat(64),
      name: "nemoclaw-portable-ollama-alpha",
      imageRef: `docker.io/library/ollama@sha256:${"1".repeat(64)}`,
      probeImageRef: `quay.io/curl/curl@sha256:${"2".repeat(64)}`,
      specSha256: "3".repeat(64),
      launchSha256: "4".repeat(64),
      modelDigest: `sha256:${"5".repeat(64)}`,
      gpu: { vendor: "nvidia", devices: [GPU_DEVICE] },
    },
  });
}

function createHarness(initiallyRunning = false, registryInitiallyRunning = false) {
  const receipt = publishedReceipt();
  const serializedReceipt = serializeHostLocalInferenceReceipt(receipt);
  const entry = {
    name: "alpha",
    agent: "hermes",
    provider: "ollama-local",
    model: "qwen3-vl:4b",
    policies: ["personal-open-internet"],
    openshellDriver: "docker",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
    endpointUrl: "https://inference.local/v1",
    hostLocalInferenceReceipt: serializedReceipt,
  } as SandboxEntry;
  const events: string[] = [];
  let running = initiallyRunning;
  let registryRunning = registryInitiallyRunning;
  let publicationState: "unpublished" | "published" = "unpublished";
  const writeExact = vi.fn((value: string) => value);
  const runtime = {
    providerId: "podman",
    authorityId: `podman-endpoint:${"a".repeat(64)}`,
    services: ["ollama"],
    resumeManaged: vi.fn(),
    inspectManaged: vi.fn(() => ({ running, receipt })),
    inspectPublishedRecoveryRestoration: vi.fn(() => ({ running, receipt })),
    validatePublishedResume: vi.fn(() => {
      events.push("provider-validate");
      return receipt;
    }),
    preserveForRebuild: vi.fn(() => receipt),
  };
  const managedOperation = {
    providerId: "podman",
    engine: {
      operation: "host-local-inference",
      engineId: "podman",
      authorityId: `podman-endpoint:${"a".repeat(64)}`,
    },
    bindingSha256: "b".repeat(64),
    assertAuthority: vi.fn(),
    assertTransactionCurrent: vi.fn(),
    managedRuntime: runtime,
  };
  const prepared: HostLocalInferencePreparedStartup = {
    receipt,
    rollbackPriorState: "stopped",
    publicationState: () => publicationState,
    validateBeforeCommit: vi.fn(() => {
      events.push("prepared-validate");
      return receipt;
    }),
    commit: vi.fn(() => {
      events.push("commit");
      publicationState = "published";
      return receipt;
    }),
    finalizePublishedResume: vi.fn((assertPublishedAuthority) => {
      events.push("finalize");
      assertPublishedAuthority();
      publicationState = "published";
      return receipt;
    }),
    rollback: vi.fn(() => {
      events.push("rollback");
      running = false;
      return { priorState: "stopped" as const, status: "restored" as const, receipt };
    }),
  };
  const prepareStartup = vi.fn((_operation: unknown, request: HostLocalInferenceStartupRequest) => {
    events.push("resume");
    expect(request).toMatchObject({
      application: "hermes",
      service: "ollama",
      managed: {
        containerName: "nemoclaw-portable-ollama-alpha",
        model: "qwen3-vl:4b",
        gpuDevices: [GPU_DEVICE],
        networkName: "openshell-docker",
      },
      resumeReceipt: receipt,
    });
    running = true;
    return { prepared, receipt };
  });
  const assertOperating = vi.fn(() => events.push("operating"));
  const assertRuntimeRetainedCurrent = vi.fn(() => events.push("runtime-retained-current"));
  const assertRuntimeTransactionCurrent = vi.fn(() =>
    events.push("runtime-transaction-current"),
  );
  const assertRuntimeCurrent = vi.fn(() => {
    events.push("runtime-current");
    expect(running).toBe(true);
  });
  const assertPublished = vi.fn(() => {
    events.push("publication");
  });
  const prepareInferenceAuthority = vi.fn(
    (
      _bundle,
      lifecycleEntry: SandboxEntry,
      _options,
      entryTiming?: {
        readonly now?: () => number;
        readonly onComplete: (durationMs: number) => void;
      },
    ) => {
      expect(lifecycleEntry).toMatchObject({
        name: "alpha",
        agent: "hermes",
        openshellDriver: "podman",
        provider: "ollama-local",
      });
      expect(lifecycleEntry.hostLocalInferenceProvenance).toBeUndefined();
      const startedAt = entryTiming?.now?.() ?? 0;
      const managedInspection = { running, receipt };
      entryTiming?.onComplete((entryTiming.now?.() ?? startedAt) - startedAt);
      return {
        serializedReceipt,
        sandboxAuthoritySha256: "6".repeat(64),
        managedInspection,
        managedOperation,
        assertPublishedRecoveryTransactionCurrent: managedOperation.assertTransactionCurrent,
      };
    },
  );
  const createRuntimeAuthority = vi.fn(() => ({
    bundle: { identity: { id: "podman" } },
    inferenceStateDir: "/state/portable-inference/alpha",
    operation: managedOperation,
    assertRetainedCurrent: assertRuntimeRetainedCurrent,
    assertTransactionCurrent: assertRuntimeTransactionCurrent,
    assertCurrent: assertRuntimeCurrent,
  }));
  const prepareRegistryRecovery = vi.fn(() => {
    const started = !registryRunning;
    started ? events.push("registry-start") : undefined;
    registryRunning = started ? true : registryRunning;
    return {
      started,
      assertCurrent: vi.fn(() => {
        events.push("registry-current");
        expect(registryRunning).toBe(true);
      }),
      assertTransactionCurrent: vi.fn(() => {
        events.push("registry-transaction-current");
        expect(registryRunning).toBe(true);
      }),
      assertRetainedCurrent: vi.fn(() => {
        events.push("registry-retained-current");
        expect(registryRunning).toBe(true);
      }),
      rollback: vi.fn(() => {
        events.push("registry-rollback");
        registryRunning = started ? false : registryRunning;
      }),
      release: vi.fn(() => events.push("registry-release")),
    };
  });
  const overrides = {
    readReceipt: vi.fn(() => ({ receipt: { phase: "active" }, successor: {} })),
    qualifyOperatingAuthority: vi.fn(() => ({
      receipt: {},
      assertTransactionCurrent: assertOperating,
      assertCurrent: assertOperating,
    })),
    createRuntimeAuthority,
    prepareRecoveryEntry: vi.fn(() => ({
      registryRecovery: prepareRegistryRecovery(),
      createRuntimeAuthority,
    })),
    prepareInferenceAuthority,
    assertPreparedInferenceAuthorityCurrent: vi.fn(() => ({ running, receipt })),
    assertPreparedInferenceAuthorityTransactionCurrent: vi.fn(),
    preparePublishedAuthority: vi.fn(() => ({
      receipt,
      serializedReceipt,
      receiptWriter: {
        transactionId: "e".repeat(64),
        targetSha256: "f".repeat(64),
        writeExact,
      },
      assertTransactionCurrent: assertPublished,
      assertCurrent: assertPublished,
    })),
    prepareRegistryRecovery,
    prepareStartup,
  };
  const input = {
    intent: "connect-probe-only" as const,
    sandboxName: "alpha",
    entry,
    env: {},
    stateDir: "/state",
    runGatewayOpenshell: vi.fn(),
    readRegistry: vi.fn(() => entry),
    verifyRoute: vi.fn(() => {
      events.push("route");
      return entry;
    }),
  };
  return {
    assertRuntimeCurrent,
    assertRuntimeRetainedCurrent,
    assertRuntimeTransactionCurrent,
    events,
    input,
    managedOperation,
    overrides,
    prepared,
    prepareStartup,
    receipt,
    registryRunning: () => registryRunning,
    runtime,
    running: () => running,
    writeExact,
  };
}

describe("Hermes Portable Ollama inference recovery", () => {
  it("classifies one running exact runtime without constructing recovery authority", () => {
    const harness = createHarness(true, true);
    const serializedReceipt = serializeHostLocalInferenceReceipt(harness.receipt);
    const assertCallerCurrent = vi.fn();
    const assertPublishedCurrent = vi.fn();
    const assertEngineCurrent = vi.fn();
    const createInspectionAuthority = vi.fn(() => ({
      engine: { operation: "host-local-inference", engineId: "podman" },
      assertTransactionCurrent: assertEngineCurrent,
    }));
    const inspectRuntime = vi.fn((options) => {
      options.assertCurrent();
      return { running: true, receipt: harness.receipt };
    });

    const result = inspectHermesPortableOllamaReadinessRuntime(
      {
        intent: "connect-probe-only",
        sandboxName: "alpha",
        entry: harness.input.entry,
        operatingReceipt: {
          phase: "active",
          sandboxName: "alpha",
          podmanExecutableAuthority: {},
          socketAuthority: {},
          runtimeAuthority: {},
        } as never,
        readRegistry: () => harness.input.entry,
        assertCallerCurrent,
        env: {},
        stateDir: "/state",
      },
      {
        preparePublishedReceiptAuthority: vi.fn(() => ({
          receipt: harness.receipt,
          serializedReceipt,
          assertCurrent: assertPublishedCurrent,
        })),
        createInspectionAuthority: createInspectionAuthority as never,
        inspectRuntime: inspectRuntime as never,
        openAuthorityStore: vi.fn(() => ({
          load: vi.fn(() => harness.receipt.engineAuthority),
          record: vi.fn(),
        })),
      },
    );

    expect(result.kind).toBe("running-current");
    expect(createInspectionAuthority).toHaveBeenCalledOnce();
    expect(inspectRuntime).toHaveBeenCalledOnce();
    expect(assertEngineCurrent).toHaveBeenCalled();
    expect(assertCallerCurrent).toHaveBeenCalled();
    expect(harness.overrides.prepareRecoveryEntry).not.toHaveBeenCalled();
    expect(harness.overrides.prepareInferenceAuthority).not.toHaveBeenCalled();
  });

  it.each(["registry", "private-publication", "engine", "persisted-engine", "container"] as const)(
    "rejects %s drift without constructing recovery authority",
    (drift) => {
      const harness = createHarness(true, true);
      const serializedReceipt = serializeHostLocalInferenceReceipt(harness.receipt);
      const expectedEntry = harness.input.entry;
      let persistedLoads = 0;
      const preparePublishedReceiptAuthority = vi.fn(() => ({
        receipt: harness.receipt,
        serializedReceipt,
        assertCurrent: vi.fn(() => {
          expect(drift).not.toBe("private-publication");
        }),
      }));
      const createInspectionAuthority = vi.fn(() => ({
        engine: { operation: "host-local-inference", engineId: "podman" },
        assertTransactionCurrent: vi.fn(() => {
          expect(drift).not.toBe("engine");
        }),
      }));
      const inspectRuntime = vi.fn(() => {
        expect(drift).not.toBe("container");
        return { running: true, receipt: harness.receipt };
      });

      expect(() =>
        inspectHermesPortableOllamaReadinessRuntime(
          {
            intent: "connect-probe-only",
            sandboxName: "alpha",
            entry: expectedEntry,
            operatingReceipt: {
              phase: "active",
              sandboxName: "alpha",
              podmanExecutableAuthority: {},
              socketAuthority: {},
              runtimeAuthority: {},
            } as never,
            readRegistry: () =>
              drift === "registry"
                ? ({ ...expectedEntry, model: "changed" } as never)
                : expectedEntry,
            assertCallerCurrent: vi.fn(),
            env: {},
            stateDir: "/state",
          },
          {
            preparePublishedReceiptAuthority,
            createInspectionAuthority: createInspectionAuthority as never,
            inspectRuntime: inspectRuntime as never,
            openAuthorityStore: vi.fn(() => ({
              load: vi.fn(() => {
                persistedLoads += 1;
                return drift === "persisted-engine" && persistedLoads > 1
                  ? null
                  : harness.receipt.engineAuthority;
              }),
              record: vi.fn(),
            })),
          },
        ),
      ).toThrow();

      expect(harness.overrides.prepareRecoveryEntry).not.toHaveBeenCalled();
      expect(harness.overrides.prepareInferenceAuthority).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing", undefined, "sandbox registry host-local inference receipt is missing"],
    ["malformed", "not-json\n", "serialized receipt is not valid JSON"],
  ] as const)(
    "rejects an ollama-local registry receipt that is %s before registry recovery",
    (_label, serializedReceipt, expectedError) => {
      const harness = createHarness();
      const entry = {
        ...harness.input.entry,
        hostLocalInferenceReceipt: serializedReceipt,
      } as SandboxEntry;

      expect(() =>
        recoverHermesPortableOllamaInference(
          {
            ...harness.input,
            entry,
            readRegistry: vi.fn(() => entry),
          },
          harness.overrides as never,
        ),
      ).toThrow(expectedError);
      expect(harness.overrides.prepareRegistryRecovery).not.toHaveBeenCalled();
    },
  );

  it("resumes one stopped published runtime and commits only after final route proof", () => {
    const harness = createHarness();

    expect(recoverHermesPortableOllamaInference(harness.input, harness.overrides as never)).toBe(
      "recovered",
    );

    expect(harness.prepareStartup).toHaveBeenCalledOnce();
    expect(harness.running()).toBe(true);
    expect(harness.registryRunning()).toBe(true);
    expect(harness.events[0]).toBe("operating");
    expect(harness.events.indexOf("registry-start")).toBeLessThan(harness.events.indexOf("resume"));
    expect(harness.events.indexOf("route")).toBeGreaterThan(
      harness.events.indexOf("prepared-validate"),
    );
    expect(harness.events.indexOf("route")).toBeLessThan(harness.events.indexOf("finalize"));
    expect(harness.prepared.commit).not.toHaveBeenCalled();
    expect(harness.prepared.rollback).not.toHaveBeenCalled();
    expect(harness.writeExact).not.toHaveBeenCalled();
    expect(harness.events.at(-1)).toBe("registry-release");
  });

  it("uses retained inference currentness until one final full qualification", () => {
    const harness = createHarness();
    const retained = vi.fn();
    const full = vi.fn(() => ({ running: true, receipt: harness.receipt }));
    harness.overrides.assertPreparedInferenceAuthorityTransactionCurrent = retained;
    harness.overrides.assertPreparedInferenceAuthorityCurrent = full;

    expect(recoverHermesPortableOllamaInference(harness.input, harness.overrides as never)).toBe(
      "recovered",
    );

    expect(retained).toHaveBeenCalledTimes(4);
    expect(full).toHaveBeenCalledOnce();
    expect(harness.assertRuntimeRetainedCurrent).toHaveBeenCalled();
    expect(harness.assertRuntimeTransactionCurrent).toHaveBeenCalledOnce();
    expect(harness.assertRuntimeCurrent).toHaveBeenCalledOnce();
    expect(harness.overrides.prepareInferenceAuthority).toHaveBeenCalledOnce();
    expect(harness.writeExact).not.toHaveBeenCalled();
  });

  it("rolls the exact stopped runtime back when retained inference authority drifts", () => {
    const harness = createHarness();
    const drift = new Error("retained inference authority changed");
    harness.overrides.assertPreparedInferenceAuthorityTransactionCurrent = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw drift;
      });

    expect(() =>
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).toThrow(drift);

    expect(harness.prepared.rollback).toHaveBeenCalledOnce();
    expect(harness.input.verifyRoute).not.toHaveBeenCalled();
    expect(harness.writeExact).not.toHaveBeenCalled();
    expect(harness.running()).toBe(false);
  });

  it("releases a prepared probe dependency only after stopped-runtime finalization", () => {
    const harness = createHarness();
    const dependency = {
      release: vi.fn(() => harness.events.push("dependency-release")),
      rollback: vi.fn(() => harness.events.push("dependency-rollback")),
    };

    expect(
      recoverHermesPortableOllamaInference(
        {
          ...harness.input,
          prepareProbeDependency: vi.fn(() => {
            harness.events.push("dependency-prepare");
            return dependency;
          }),
        },
        harness.overrides as never,
      ),
    ).toBe("recovered");

    expect(harness.events.indexOf("route")).toBeLessThan(
      harness.events.indexOf("dependency-prepare"),
    );
    expect(harness.events.indexOf("dependency-prepare")).toBeLessThan(
      harness.events.indexOf("finalize"),
    );
    expect(harness.events.indexOf("finalize")).toBeLessThan(
      harness.events.indexOf("dependency-release"),
    );
    expect(harness.events.indexOf("registry-release")).toBeLessThan(
      harness.events.indexOf("dependency-release"),
    );
    expect(dependency.rollback).not.toHaveBeenCalled();
  });

  it("restores the stopped runtime when probe-dependency preparation fails", () => {
    const harness = createHarness();
    const canary = new Error("forward preparation failed");

    expect(() =>
      recoverHermesPortableOllamaInference(
        {
          ...harness.input,
          prepareProbeDependency: vi.fn(() => {
            throw canary;
          }),
        },
        harness.overrides as never,
      ),
    ).toThrow(canary);

    expect(harness.prepared.rollback).toHaveBeenCalledOnce();
    expect(harness.running()).toBe(false);
    expect(harness.registryRunning()).toBe(false);
    expect(harness.events.indexOf("rollback")).toBeLessThan(
      harness.events.indexOf("registry-rollback"),
    );
  });

  it("rolls back a prepared probe dependency before the stopped runtime", () => {
    const harness = createHarness();
    const dependency = {
      release: vi.fn(() => harness.events.push("dependency-release")),
      rollback: vi.fn(() => harness.events.push("dependency-rollback")),
    };
    vi.mocked(harness.prepared.finalizePublishedResume!).mockImplementation(() => {
      harness.events.push("finalize");
      throw new Error("finalization failed");
    });

    expect(() =>
      recoverHermesPortableOllamaInference(
        { ...harness.input, prepareProbeDependency: vi.fn(() => dependency) },
        harness.overrides as never,
      ),
    ).toThrow("finalization failed");

    expect(dependency.release).not.toHaveBeenCalled();
    expect(harness.events.indexOf("dependency-rollback")).toBeLessThan(
      harness.events.indexOf("rollback"),
    );
    expect(harness.events.indexOf("rollback")).toBeLessThan(
      harness.events.indexOf("registry-rollback"),
    );
    expect(harness.running()).toBe(false);
    expect(harness.registryRunning()).toBe(false);
  });

  it("restores forwards, the stopped runtime, and the registry after retained command drift", () => {
    const harness = createHarness();
    const commandDrift = new Error("retained command authority changed");
    const assertCallerCurrent = vi.fn(() => {
      harness.events.push("caller-current");
    });
    const dependency = {
      release: vi.fn(() => harness.events.push("dependency-release")),
      rollback: vi.fn(() => harness.events.push("dependency-rollback")),
    };

    expect(() =>
      recoverHermesPortableOllamaInference(
        {
          ...harness.input,
          assertCallerCurrent,
          prepareProbeDependency: vi.fn(() => {
            harness.events.push("dependency-prepare");
            assertCallerCurrent.mockImplementation(() => {
              throw commandDrift;
            });
            return dependency;
          }),
        },
        harness.overrides as never,
      ),
    ).toThrow(commandDrift);

    expect(dependency.release).not.toHaveBeenCalled();
    expect(dependency.rollback).toHaveBeenCalledOnce();
    expect(harness.prepared.rollback).toHaveBeenCalledOnce();
    expect(harness.events.indexOf("dependency-rollback")).toBeLessThan(
      harness.events.indexOf("rollback"),
    );
    expect(harness.events.indexOf("rollback")).toBeLessThan(
      harness.events.indexOf("registry-rollback"),
    );
    expect(harness.running()).toBe(false);
    expect(harness.registryRunning()).toBe(false);
  });

  it("keeps runtime restoration uncertainty dominant when command drift also breaks forward rollback", () => {
    const harness = createHarness();
    const commandDrift = new Error("retained command authority changed");
    const assertCallerCurrent = vi.fn();
    const dependency = {
      release: vi.fn(),
      rollback: vi.fn(() => {
        harness.events.push("dependency-rollback");
        throw new Error("forward restoration unproved");
      }),
    };
    vi.mocked(harness.prepared.rollback).mockImplementation(() => {
      harness.events.push("rollback");
      return {
        priorState: "stopped",
        status: "retained",
        receipt: harness.receipt,
      } as never;
    });

    let caught: unknown;
    try {
      recoverHermesPortableOllamaInference(
        {
          ...harness.input,
          assertCallerCurrent,
          prepareProbeDependency: vi.fn(() => {
            assertCallerCurrent.mockImplementation(() => {
              throw commandDrift;
            });
            return dependency;
          }),
        },
        harness.overrides as never,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HermesPortableOllamaRecoveryError);
    expect(caught).toMatchObject({ failure: "runtime-restoration-unproved" });
    expect(dependency.rollback).toHaveBeenCalledOnce();
    expect(harness.prepared.rollback).toHaveBeenCalledOnce();
    expect(harness.events.indexOf("dependency-rollback")).toBeLessThan(
      harness.events.indexOf("rollback"),
    );
    expect(harness.events).not.toContain("registry-rollback");
    expect(harness.running()).toBe(true);
    expect(harness.registryRunning()).toBe(true);
  });

  it("preserves probe-dependency restoration uncertainty after restoring Ollama", () => {
    const harness = createHarness();
    const restorationError = new Error("forward restoration unproved");
    const dependency = {
      release: vi.fn(),
      rollback: vi.fn(() => {
        harness.events.push("dependency-rollback");
        throw restorationError;
      }),
    };
    vi.mocked(harness.prepared.finalizePublishedResume!).mockImplementation(() => {
      harness.events.push("finalize");
      throw new Error("lower finalization canary");
    });

    expect(() =>
      recoverHermesPortableOllamaInference(
        { ...harness.input, prepareProbeDependency: vi.fn(() => dependency) },
        harness.overrides as never,
      ),
    ).toThrow(restorationError);

    expect(harness.prepared.rollback).toHaveBeenCalledOnce();
    expect(harness.running()).toBe(false);
    expect(harness.registryRunning()).toBe(false);
    expect(harness.events.indexOf("dependency-rollback")).toBeLessThan(
      harness.events.indexOf("rollback"),
    );
  });

  it("validates an already running runtime without invoking resume", () => {
    const harness = createHarness(true, true);

    expect(recoverHermesPortableOllamaInference(harness.input, harness.overrides as never)).toBe(
      "reused",
    );

    expect(harness.runtime.validatePublishedResume).toHaveBeenCalledOnce();
    expect(harness.runtime.preserveForRebuild).not.toHaveBeenCalled();
    expect(harness.prepareStartup).not.toHaveBeenCalled();
    expect(harness.events).toContain("route");
    expect(harness.events).not.toContain("registry-start");
    expect(harness.events.at(-1)).toBe("registry-release");
  });

  it("preserves an existing recovery failure classification", () => {
    const harness = createHarness(true, true);
    const nested = new HermesPortableOllamaRecoveryError(
      "runtime-restoration-unproved",
      "nested recovery remained indeterminate",
    );
    harness.input.verifyRoute.mockImplementation(() => {
      throw nested;
    });

    let caught: unknown;
    try {
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(nested);
    expect(caught).toMatchObject({ failure: "runtime-restoration-unproved" });
    expect(harness.events).toContain("registry-rollback");
    expect(harness.events).not.toContain("registry-release");
  });

  it("rejects a running runtime when published resume validation is unavailable", () => {
    const harness = createHarness(true, true);
    const { validatePublishedResume: _validatePublishedResume, ...runtimeWithoutValidator } =
      harness.runtime;
    harness.managedOperation.managedRuntime = runtimeWithoutValidator as never;

    expect(() =>
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).toThrow("runtime provider lacks published resume validation");

    expect(harness.input.verifyRoute).not.toHaveBeenCalled();
    expect(harness.prepareStartup).not.toHaveBeenCalled();
    expect(harness.events).not.toContain("registry-release");
  });

  it("does not invent runtime rollback for an already-running Ollama dependency failure", () => {
    const harness = createHarness(true, true);
    const dependency = {
      release: vi.fn(),
      rollback: vi.fn(() => {
        harness.events.push("dependency-rollback");
      }),
    };
    harness.overrides.prepareRegistryRecovery.mockReturnValue({
      started: false,
      assertRetainedCurrent: vi.fn(),
      assertTransactionCurrent: vi.fn(),
      assertCurrent: vi.fn(),
      rollback: vi.fn(() => {
        harness.events.push("registry-rollback");
      }),
      release: vi.fn(() => {
        throw new Error("registry finalization failed");
      }),
    });

    expect(() =>
      recoverHermesPortableOllamaInference(
        { ...harness.input, prepareProbeDependency: vi.fn(() => dependency) },
        harness.overrides as never,
      ),
    ).toThrow("registry finalization failed");

    expect(dependency.rollback).toHaveBeenCalledOnce();
    expect(harness.prepared.rollback).not.toHaveBeenCalled();
    expect(harness.running()).toBe(true);
  });

  it("reconciles a stopped registry before validating an already running runtime", () => {
    const harness = createHarness(true);

    expect(recoverHermesPortableOllamaInference(harness.input, harness.overrides as never)).toBe(
      "reused",
    );

    expect(harness.events).toContain("registry-start");
    expect(harness.runtime.validatePublishedResume).toHaveBeenCalledOnce();
    expect(harness.runtime.preserveForRebuild).not.toHaveBeenCalled();
    expect(harness.prepareStartup).not.toHaveBeenCalled();
    expect(harness.registryRunning()).toBe(true);
    expect(harness.events.at(-1)).toBe("registry-release");
  });

  it("emits failed timing after final route failure restores the exact stopped state", () => {
    const harness = createHarness();
    let now = 0;
    const routeError = new Error("route unavailable");
    const onComplete = vi.fn(() => harness.events.push("timing"));
    Object.assign(harness.overrides, {
      recoveryTiming: {
        now: () => ++now,
        onComplete,
      },
    });
    harness.input.verifyRoute.mockImplementation(() => {
      throw routeError;
    });

    let caught: unknown;
    try {
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(routeError);
    expect(harness.prepared.rollback).toHaveBeenCalledOnce();
    expect(harness.prepared.commit).not.toHaveBeenCalled();
    expect(harness.running()).toBe(false);
    expect(harness.registryRunning()).toBe(false);
    expect(harness.events.indexOf("rollback")).toBeLessThan(
      harness.events.indexOf("registry-rollback"),
    );
    expect(harness.events.indexOf("registry-rollback")).toBeLessThan(
      harness.events.indexOf("timing"),
    );
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        dependencyMs: 0,
        finalCurrentnessMs: 0,
        result: "failed",
        routeMs: 1,
        runtimeAction: "recovered",
      }),
    );
  });

  it("restores the exact stopped state when provider revalidation fails", () => {
    const harness = createHarness();
    vi.mocked(harness.prepared.validateBeforeCommit).mockImplementation(() => {
      throw new Error("provider unavailable");
    });

    expect(() =>
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).toThrow("provider unavailable");

    expect(harness.prepared.rollback).toHaveBeenCalledOnce();
    expect(harness.input.verifyRoute).not.toHaveBeenCalled();
    expect(harness.running()).toBe(false);
    expect(harness.registryRunning()).toBe(false);
    expect(harness.events.indexOf("rollback")).toBeLessThan(
      harness.events.indexOf("registry-rollback"),
    );
  });

  it("restores the exact stopped state when final published authority changes", () => {
    const harness = createHarness();
    const assertCurrent = vi.fn(() => {
      throw new Error("published authority changed");
    });
    harness.overrides.preparePublishedAuthority.mockReturnValue({
      receipt: harness.receipt,
      serializedReceipt: serializeHostLocalInferenceReceipt(harness.receipt),
      receiptWriter: {
        transactionId: "e".repeat(64),
        targetSha256: "f".repeat(64),
        writeExact: harness.writeExact,
      },
      assertTransactionCurrent: vi.fn(),
      assertCurrent,
    });

    expect(() =>
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).toThrow("published authority changed");

    expect(harness.input.verifyRoute).toHaveBeenCalledOnce();
    expect(harness.prepared.finalizePublishedResume).toHaveBeenCalledOnce();
    expect(harness.prepared.rollback).toHaveBeenCalledOnce();
    expect(harness.writeExact).not.toHaveBeenCalled();
    expect(harness.running()).toBe(false);
    expect(harness.registryRunning()).toBe(false);
  });

  it("rejects Ollama registry provenance before runtime mutation", () => {
    const harness = createHarness();
    harness.input.entry = {
      ...harness.input.entry,
      hostLocalInferenceProvenance: {
        schemaVersion: 1,
        sandboxName: "alpha",
        receiptSha256: "9".repeat(64),
      },
    } as never;
    harness.input.readRegistry.mockReturnValue(harness.input.entry);

    expect(() =>
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).toThrow("Ollama registry must not contain llama.cpp provenance");

    expect(harness.prepareStartup).not.toHaveBeenCalled();
    expect(harness.running()).toBe(false);
    expect(harness.registryRunning()).toBe(false);
    expect(harness.events).not.toContain("registry-start");
  });

  it("is idempotent across a recovered probe and a second probe", () => {
    const harness = createHarness();

    expect(recoverHermesPortableOllamaInference(harness.input, harness.overrides as never)).toBe(
      "recovered",
    );
    expect(recoverHermesPortableOllamaInference(harness.input, harness.overrides as never)).toBe(
      "reused",
    );

    expect(harness.prepareStartup).toHaveBeenCalledOnce();
    expect(harness.runtime.validatePublishedResume).toHaveBeenCalledOnce();
    expect(harness.runtime.preserveForRebuild).not.toHaveBeenCalled();
    expect(harness.events.filter((event) => event === "registry-start")).toHaveLength(1);
    expect(harness.events.filter((event) => event === "registry-release")).toHaveLength(2);
  });

  it.each([
    ["recovered", false],
    ["reused", true],
  ] as const)("emits fixed outer timing after a successful %s transaction", (action, running) => {
    const harness = createHarness(running, running);
    let now = 0;
    const onComplete = vi.fn();
    Object.assign(harness.overrides, {
      recoveryTiming: {
        now: () => ++now,
        onComplete,
      },
    });

    expect(recoverHermesPortableOllamaInference(harness.input, harness.overrides as never)).toBe(
      action,
    );

    expect(onComplete).toHaveBeenCalledOnce();
    const evidence = onComplete.mock.calls[0]?.[0];
    expect(Object.keys(evidence).sort()).toEqual([
      "dependencyMs",
      "entryAuthorityMs",
      "exactRuntimeInspectionMs",
      "finalCurrentnessMs",
      "fullCurrentnessCount",
      "operatingAuthorityMs",
      "preRouteCurrentnessMs",
      "preparedAuthorityInspectionCount",
      "preparedInferenceAuthorityMs",
      "privatePublicationMs",
      "registryPreparationMs",
      "result",
      "retainedCurrentnessCount",
      "routeMs",
      "runtimeAction",
      "runtimeAuthorityMs",
      "totalMs",
    ]);
    expect(evidence).toMatchObject({
      exactRuntimeInspectionMs: 1,
      operatingAuthorityMs: 1,
      preparedInferenceAuthorityMs: 2,
      privatePublicationMs: 1,
      registryPreparationMs: 1,
      retainedCurrentnessCount: action === "recovered" ? 4 : 3,
      fullCurrentnessCount: 1,
      preparedAuthorityInspectionCount: 2,
      result: "proved",
      runtimeAction: action,
      runtimeAuthorityMs: 1,
    });
    expect(
      Object.entries(evidence)
        .filter(([key]) => key.endsWith("Ms"))
        .every(([, value]) => typeof value === "number" && value >= 0),
    ).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("qwen3-vl");
  });

  it("rejects registry drift before a runtime resume", () => {
    const harness = createHarness();
    harness.input.readRegistry.mockReturnValue({ ...harness.input.entry, model: "changed" });

    expect(() =>
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).toThrow("sandbox registry authority changed before recovery");

    expect(harness.prepareStartup).not.toHaveBeenCalled();
    expect(harness.running()).toBe(false);
  });

  it("restores a started registry when runtime reconstruction fails before Ollama mutation", () => {
    const harness = createHarness();
    harness.overrides.createRuntimeAuthority.mockImplementation(() => {
      throw new Error("runtime authority unavailable");
    });

    let caught: unknown;
    try {
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HermesPortableOllamaRecoveryPhaseError);
    expect(caught).toMatchObject({ phase: "RUNTIME_AUTHORITY" });
    expect((caught as Error).message).not.toContain("runtime authority unavailable");

    expect(harness.prepareStartup).not.toHaveBeenCalled();
    expect(harness.registryRunning()).toBe(false);
    expect(harness.events).toContain("registry-rollback");
  });

  it("keeps engine qualification distinct from registry recovery postconditions", () => {
    const harness = createHarness();
    harness.overrides.prepareRecoveryEntry.mockImplementation(() => {
      throw new HermesPortableOllamaRecoveryPhaseError("REGISTRY_PREPARATION_AUTHORITY");
    });

    let caught: unknown;
    try {
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HermesPortableOllamaRecoveryPhaseError);
    expect(caught).toMatchObject({ phase: "REGISTRY_PREPARATION_AUTHORITY" });
    expect(harness.overrides.prepareRegistryRecovery).not.toHaveBeenCalled();
    expect(harness.prepareStartup).not.toHaveBeenCalled();
  });

  it.each([
    ["registry", "REGISTRY_PREPARATION_POSTCONDITION", 0],
    ["runtime", "RUNTIME_AUTHORITY", 1],
    ["lifecycle", "LIFECYCLE_AUTHORITY", 1],
    ["private-publication", "PRIVATE_PUBLICATION_AUTHORITY", 1],
    ["runtime-inspection", "EXACT_RUNTIME_INSPECTION", 1],
  ] as const)(
    "classifies the fixed %s failure boundary after rollback",
    (owner, phase, registryRollbackCount) => {
      const harness = createHarness();
      const canary = "nested recovery diagnostic canary";
      const onComplete = vi.fn();
      Object.assign(harness.overrides, { recoveryTiming: { onComplete } });
      switch (owner) {
        case "registry":
          harness.overrides.prepareRegistryRecovery.mockImplementation(() => {
            throw new Error(canary);
          });
          break;
        case "runtime":
          harness.overrides.createRuntimeAuthority.mockImplementation(() => {
            throw new Error(canary);
          });
          break;
        case "lifecycle":
          harness.overrides.prepareInferenceAuthority.mockImplementation(() => {
            throw new Error(canary);
          });
          break;
        case "private-publication":
          harness.overrides.preparePublishedAuthority.mockImplementation(() => {
            throw new Error(canary);
          });
          break;
        case "runtime-inspection":
          {
            const prepare = harness.overrides.prepareInferenceAuthority.getMockImplementation()!;
            harness.overrides.prepareInferenceAuthority.mockImplementation((...args) => {
              const preparedAuthority = prepare(...args);
              return {
                ...preparedAuthority,
                get managedInspection(): NonNullable<typeof preparedAuthority.managedInspection> {
                  throw new Error(canary);
                },
              };
            });
          }
          break;
      }

      let caught: unknown;
      try {
        recoverHermesPortableOllamaInference(harness.input, harness.overrides as never);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(HermesPortableOllamaRecoveryPhaseError);
      expect(caught).toMatchObject({ phase });
      expect((caught as Error).message).not.toContain(canary);
      expect(harness.registryRunning()).toBe(false);
      expect(harness.events.filter((event) => event === "registry-rollback")).toHaveLength(
        registryRollbackCount,
      );
      expect(harness.prepareStartup).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledOnce();
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({ result: "failed", runtimeAction: "unknown" }),
      );
    },
  );

  it("maps the exact registry phase without disclosing the nested diagnostic", () => {
    let caught: unknown;
    try {
      rethrowHermesPortableOllamaRegistryRecoveryError(
        Object.assign(new PortableRegistryRecoveryPhaseError("NETWORK_INSPECTION"), {
          nestedDiagnostic: "registry phase canary",
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HermesPortableOllamaRecoveryPhaseError);
    expect(caught).toMatchObject({ phase: "REGISTRY_PREPARATION_NETWORK_INSPECTION" });
    expect((caught as Error).message).not.toContain("registry phase canary");
  });

  it("maps registry restoration uncertainty ahead of the nested phase", () => {
    let caught: unknown;
    try {
      rethrowHermesPortableOllamaRegistryRecoveryError(
        Object.assign(new PortableRegistryRecoveryRestorationError(), {
          phase: "NETWORK_INSPECTION",
          nestedDiagnostic: "registry restoration canary",
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HermesPortableOllamaRecoveryError);
    expect(caught).toMatchObject({ failure: "registry-restoration-unproved" });
    expect((caught as Error).message).not.toContain("registry restoration canary");
  });

  it("reports registry restoration uncertainty instead of the nested phase", () => {
    const harness = createHarness();
    const canary = "nested recovery diagnostic canary";
    harness.overrides.prepareRegistryRecovery.mockReturnValue({
      started: true,
      assertRetainedCurrent: vi.fn(),
      assertTransactionCurrent: vi.fn(),
      assertCurrent: vi.fn(),
      rollback: vi.fn(() => {
        throw new Error(canary);
      }),
      release: vi.fn(),
    });
    harness.overrides.createRuntimeAuthority.mockImplementation(() => {
      throw new Error(canary);
    });

    let caught: unknown;
    try {
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HermesPortableOllamaRecoveryError);
    expect(caught).toMatchObject({ failure: "registry-restoration-unproved" });
    expect((caught as Error).message).not.toContain(canary);
    expect(harness.prepareStartup).not.toHaveBeenCalled();
  });

  it("rejects direct launch intent before registry or runtime mutation", () => {
    const harness = createHarness();

    expect(() =>
      recoverHermesPortableOllamaInference(
        { ...harness.input, intent: "launch" } as never,
        harness.overrides as never,
      ),
    ).toThrow("restricted to connect --probe-only");

    expect(harness.overrides.prepareRegistryRecovery).not.toHaveBeenCalled();
    expect(harness.prepareStartup).not.toHaveBeenCalled();
    expect(harness.registryRunning()).toBe(false);
  });
});
