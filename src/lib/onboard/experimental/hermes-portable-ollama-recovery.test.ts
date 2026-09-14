// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry/types";
import { serializeHostLocalInferenceReceipt } from "../runtime-provider/host-local-inference";
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

import { createHarness } from "./hermes-portable-ollama-recovery.test-fixture";

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
    inspectRuntime.mockReturnValueOnce({ running: false, receipt: harness.receipt });
    expect(result.reinspect?.().kind).toBe("stopped");
    expect(createInspectionAuthority).toHaveBeenCalledOnce();
    expect(inspectRuntime).toHaveBeenCalledTimes(2);
    assertPublishedCurrent.mockImplementation(() => {
      throw new Error("publication changed");
    });
    expect(result.reinspect).toThrow("publication changed");
    expect(inspectRuntime).toHaveBeenCalledTimes(2);
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
    async (_label, serializedReceipt, expectedError) => {
      const harness = createHarness();
      const entry = {
        ...harness.input.entry,
        hostLocalInferenceReceipt: serializedReceipt,
      } as SandboxEntry;

      await expect(
        recoverHermesPortableOllamaInference(
          {
            ...harness.input,
            entry,
            readRegistry: vi.fn(() => entry),
          },
          harness.overrides as never,
        ),
      ).rejects.toThrow(expectedError);
      expect(harness.overrides.prepareRegistryRecovery).not.toHaveBeenCalled();
    },
  );

  it("resumes one stopped published runtime and commits only after final route proof", async () => {
    const harness = createHarness();

    expect(
      await recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).toBe("recovered");

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

  it("uses retained inference currentness until one final full qualification", async () => {
    const harness = createHarness();
    const retained = vi.fn();
    const full = vi.fn(() => ({ running: true, receipt: harness.receipt }));
    harness.overrides.assertPreparedInferenceAuthorityTransactionCurrent = retained;
    harness.overrides.assertPreparedInferenceAuthorityCurrent = full;

    expect(
      await recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).toBe("recovered");

    expect(retained).toHaveBeenCalledTimes(4);
    expect(full).toHaveBeenCalledOnce();
    expect(harness.assertRuntimeRetainedCurrent).toHaveBeenCalled();
    expect(harness.assertRuntimeTransactionCurrent).toHaveBeenCalledOnce();
    expect(harness.assertRuntimeCurrent).toHaveBeenCalledOnce();
    expect(harness.overrides.prepareInferenceAuthority).toHaveBeenCalledOnce();
    expect(harness.writeExact).not.toHaveBeenCalled();
  });

  it("rolls the exact stopped runtime back when retained inference authority drifts", async () => {
    const harness = createHarness();
    const drift = new Error("retained inference authority changed");
    harness.overrides.assertPreparedInferenceAuthorityTransactionCurrent = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw drift;
      });

    await expect(
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).rejects.toThrow(drift);

    expect(harness.prepared.rollback).toHaveBeenCalledOnce();
    expect(harness.input.verifyRoute).not.toHaveBeenCalled();
    expect(harness.writeExact).not.toHaveBeenCalled();
    expect(harness.running()).toBe(false);
  });

  it("releases a prepared probe dependency only after stopped-runtime finalization", async () => {
    const harness = createHarness();
    const dependency = {
      release: vi.fn(() => harness.events.push("dependency-release")),
      rollback: vi.fn(() => {
        harness.events.push("dependency-rollback");
      }),
    };

    expect(
      await recoverHermesPortableOllamaInference(
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

  it("restores the stopped runtime when probe-dependency preparation fails", async () => {
    const harness = createHarness();
    const canary = new Error("forward preparation failed");

    await expect(
      recoverHermesPortableOllamaInference(
        {
          ...harness.input,
          prepareProbeDependency: vi.fn(() => {
            throw canary;
          }),
        },
        harness.overrides as never,
      ),
    ).rejects.toThrow(canary);

    expect(harness.prepared.rollback).toHaveBeenCalledOnce();
    expect(harness.running()).toBe(false);
    expect(harness.registryRunning()).toBe(false);
    expect(harness.events.indexOf("rollback")).toBeLessThan(
      harness.events.indexOf("registry-rollback"),
    );
  });

  it("awaits probe dependency rollback before restoring the stopped runtime", async () => {
    const harness = createHarness();
    const dependency = {
      release: vi.fn(() => harness.events.push("dependency-release")),
      rollback: vi.fn(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        harness.events.push("dependency-rollback");
      }),
    };
    vi.mocked(harness.prepared.finalizePublishedResume!).mockImplementation(() => {
      harness.events.push("finalize");
      throw new Error("finalization failed");
    });

    await expect(
      recoverHermesPortableOllamaInference(
        { ...harness.input, prepareProbeDependency: vi.fn(() => dependency) },
        harness.overrides as never,
      ),
    ).rejects.toThrow("finalization failed");

    expect(harness.events).toContain("dependency-rollback");
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

  it("restores forwards, the stopped runtime, and the registry after retained command drift", async () => {
    const harness = createHarness();
    const commandDrift = new Error("retained command authority changed");
    const assertCallerCurrent = vi.fn(() => {
      harness.events.push("caller-current");
    });
    const dependency = {
      release: vi.fn(() => harness.events.push("dependency-release")),
      rollback: vi.fn(() => {
        harness.events.push("dependency-rollback");
      }),
    };

    await expect(
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
    ).rejects.toThrow(commandDrift);

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

  it("keeps runtime restoration uncertainty dominant when command drift also breaks forward rollback", async () => {
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
      await recoverHermesPortableOllamaInference(
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

  it("preserves probe-dependency restoration uncertainty after restoring Ollama", async () => {
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

    await expect(
      recoverHermesPortableOllamaInference(
        { ...harness.input, prepareProbeDependency: vi.fn(() => dependency) },
        harness.overrides as never,
      ),
    ).rejects.toThrow(restorationError);

    expect(harness.prepared.rollback).toHaveBeenCalledOnce();
    expect(harness.running()).toBe(false);
    expect(harness.registryRunning()).toBe(false);
    expect(harness.events.indexOf("dependency-rollback")).toBeLessThan(
      harness.events.indexOf("rollback"),
    );
  });

  it("validates an already running runtime without invoking resume", async () => {
    const harness = createHarness(true, true);

    expect(
      await recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).toBe("reused");

    expect(harness.runtime.validatePublishedResume).toHaveBeenCalledOnce();
    expect(harness.runtime.preserveForRebuild).not.toHaveBeenCalled();
    expect(harness.prepareStartup).not.toHaveBeenCalled();
    expect(harness.events).toContain("route");
    expect(harness.events).not.toContain("registry-start");
    expect(harness.events.at(-1)).toBe("registry-release");
  });

  it("preserves an existing recovery failure classification", async () => {
    const harness = createHarness(true, true);
    const nested = new HermesPortableOllamaRecoveryError(
      "runtime-restoration-unproved",
      "nested recovery remained indeterminate",
    );
    harness.input.verifyRoute.mockImplementation(async () => {
      throw nested;
    });

    let caught: unknown;
    try {
      await recoverHermesPortableOllamaInference(harness.input, harness.overrides as never);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(nested);
    expect(caught).toMatchObject({ failure: "runtime-restoration-unproved" });
    expect(harness.events).toContain("registry-rollback");
    expect(harness.events).not.toContain("registry-release");
  });

  it("rejects a running runtime when published resume validation is unavailable", async () => {
    const harness = createHarness(true, true);
    const { validatePublishedResume: _validatePublishedResume, ...runtimeWithoutValidator } =
      harness.runtime;
    harness.managedOperation.managedRuntime = runtimeWithoutValidator as never;

    await expect(
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).rejects.toThrow("runtime provider lacks published resume validation");

    expect(harness.input.verifyRoute).not.toHaveBeenCalled();
    expect(harness.prepareStartup).not.toHaveBeenCalled();
    expect(harness.events).not.toContain("registry-release");
  });

  it("does not invent runtime rollback for an already-running Ollama dependency failure", async () => {
    const harness = createHarness(true, true);
    const dependency = {
      release: vi.fn(),
      rollback: vi.fn(async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
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

    await expect(
      recoverHermesPortableOllamaInference(
        { ...harness.input, prepareProbeDependency: vi.fn(() => dependency) },
        harness.overrides as never,
      ),
    ).rejects.toThrow("registry finalization failed");

    expect(harness.events).toContain("dependency-rollback");
    expect(dependency.rollback).toHaveBeenCalledOnce();
    expect(harness.prepared.rollback).not.toHaveBeenCalled();
    expect(harness.running()).toBe(true);
  });

  it("reconciles a stopped registry before validating an already running runtime", async () => {
    const harness = createHarness(true);

    expect(
      await recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).toBe("reused");

    expect(harness.events).toContain("registry-start");
    expect(harness.runtime.validatePublishedResume).toHaveBeenCalledOnce();
    expect(harness.runtime.preserveForRebuild).not.toHaveBeenCalled();
    expect(harness.prepareStartup).not.toHaveBeenCalled();
    expect(harness.registryRunning()).toBe(true);
    expect(harness.events.at(-1)).toBe("registry-release");
  });

  it("emits failed timing after final route failure restores the exact stopped state", async () => {
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
    harness.input.verifyRoute.mockImplementation(async () => {
      throw routeError;
    });

    let caught: unknown;
    try {
      await recoverHermesPortableOllamaInference(harness.input, harness.overrides as never);
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

  it("restores the exact stopped state when provider revalidation fails", async () => {
    const harness = createHarness();
    vi.mocked(harness.prepared.validateBeforeCommit).mockImplementation(() => {
      throw new Error("provider unavailable");
    });

    await expect(
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).rejects.toThrow("provider unavailable");

    expect(harness.prepared.rollback).toHaveBeenCalledOnce();
    expect(harness.input.verifyRoute).not.toHaveBeenCalled();
    expect(harness.running()).toBe(false);
    expect(harness.registryRunning()).toBe(false);
    expect(harness.events.indexOf("rollback")).toBeLessThan(
      harness.events.indexOf("registry-rollback"),
    );
  });

  it("restores the exact stopped state when final published authority changes", async () => {
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

    await expect(
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).rejects.toThrow("published authority changed");

    expect(harness.input.verifyRoute).toHaveBeenCalledOnce();
    expect(harness.prepared.finalizePublishedResume).toHaveBeenCalledOnce();
    expect(harness.prepared.rollback).toHaveBeenCalledOnce();
    expect(harness.writeExact).not.toHaveBeenCalled();
    expect(harness.running()).toBe(false);
    expect(harness.registryRunning()).toBe(false);
  });

  it("rejects Ollama registry provenance before runtime mutation", async () => {
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

    await expect(
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).rejects.toThrow("Ollama registry must not contain llama.cpp provenance");

    expect(harness.prepareStartup).not.toHaveBeenCalled();
    expect(harness.running()).toBe(false);
    expect(harness.registryRunning()).toBe(false);
    expect(harness.events).not.toContain("registry-start");
  });

  it("is idempotent across a recovered probe and a second probe", async () => {
    const harness = createHarness();

    expect(
      await recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).toBe("recovered");
    expect(
      await recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).toBe("reused");

    expect(harness.prepareStartup).toHaveBeenCalledOnce();
    expect(harness.runtime.validatePublishedResume).toHaveBeenCalledOnce();
    expect(harness.runtime.preserveForRebuild).not.toHaveBeenCalled();
    expect(harness.events.filter((event) => event === "registry-start")).toHaveLength(1);
    expect(harness.events.filter((event) => event === "registry-release")).toHaveLength(2);
  });

  it.each([
    ["recovered", false],
    ["reused", true],
  ] as const)(
    "emits fixed outer timing after a successful %s transaction",
    async (action, running) => {
      const harness = createHarness(running, running);
      let now = 0;
      const onComplete = vi.fn();
      Object.assign(harness.overrides, {
        recoveryTiming: {
          now: () => ++now,
          onComplete,
        },
      });

      expect(
        await recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
      ).toBe(action);

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
    },
  );

  it("rejects registry drift before a runtime resume", async () => {
    const harness = createHarness();
    harness.input.readRegistry.mockReturnValue({ ...harness.input.entry, model: "changed" });

    await expect(
      recoverHermesPortableOllamaInference(harness.input, harness.overrides as never),
    ).rejects.toThrow("sandbox registry authority changed before recovery");

    expect(harness.prepareStartup).not.toHaveBeenCalled();
    expect(harness.running()).toBe(false);
  });

  it("restores a started registry when runtime reconstruction fails before Ollama mutation", async () => {
    const harness = createHarness();
    harness.overrides.createRuntimeAuthority.mockImplementation(() => {
      throw new Error("runtime authority unavailable");
    });

    let caught: unknown;
    try {
      await recoverHermesPortableOllamaInference(harness.input, harness.overrides as never);
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

  it("keeps engine qualification distinct from registry recovery postconditions", async () => {
    const harness = createHarness();
    harness.overrides.prepareRecoveryEntry.mockImplementation(() => {
      throw new HermesPortableOllamaRecoveryPhaseError("REGISTRY_PREPARATION_AUTHORITY");
    });

    let caught: unknown;
    try {
      await recoverHermesPortableOllamaInference(harness.input, harness.overrides as never);
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
    async (owner, phase, registryRollbackCount) => {
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
        await recoverHermesPortableOllamaInference(harness.input, harness.overrides as never);
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

  it("reports registry restoration uncertainty instead of the nested phase", async () => {
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
      await recoverHermesPortableOllamaInference(harness.input, harness.overrides as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HermesPortableOllamaRecoveryError);
    expect(caught).toMatchObject({ failure: "registry-restoration-unproved" });
    expect((caught as Error).message).not.toContain(canary);
    expect(harness.prepareStartup).not.toHaveBeenCalled();
  });

  it("rejects direct launch intent before registry or runtime mutation", async () => {
    const harness = createHarness();

    await expect(
      recoverHermesPortableOllamaInference(
        { ...harness.input, intent: "launch" } as never,
        harness.overrides as never,
      ),
    ).rejects.toThrow("restricted to connect --probe-only");

    expect(harness.overrides.prepareRegistryRecovery).not.toHaveBeenCalled();
    expect(harness.prepareStartup).not.toHaveBeenCalled();
    expect(harness.registryRunning()).toBe(false);
  });
});
