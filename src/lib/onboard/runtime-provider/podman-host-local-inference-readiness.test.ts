// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createPodmanHostLocalInferenceTestHarness } from "../../../../test/helpers/podman-host-local-inference-test-harness";
import type { HostLocalInferenceRuntime } from "./host-local-inference";
import { serializeHostLocalInferenceReceipt } from "./host-local-inference";
import {
  createPodmanHostLocalInferenceOperation,
  inspectPodmanPublishedOllamaReadinessRuntime,
} from "./podman-host-local-inference";

function operationRuntime(
  harness: ReturnType<typeof createPodmanHostLocalInferenceTestHarness>,
): HostLocalInferenceRuntime {
  const operation = createPodmanHostLocalInferenceOperation({
    engine: harness.engine,
    env: harness.env,
    acceleration: harness.operationAcceleration,
    probeCleanupTiming: harness.probeCleanupTiming,
    authorityStore: harness.authorityStore,
    routeAuthorityStore: harness.routeAuthorityStore,
    onFailureEvidence: harness.onFailureEvidence,
    redactSensitive: harness.redactSensitive,
  });
  return (
    operation.managedRuntime ??
    (() => {
      throw new Error("test operation lacks managed runtime");
    })()
  );
}

function publishedRuntime() {
  const harness = createPodmanHostLocalInferenceTestHarness({ service: "ollama" });
  const runtime = operationRuntime(harness);
  const prepared = runtime.startManaged(
    { ...harness.input, model: "nemotron:latest" },
    harness.writer,
  );
  prepared.validateBeforeCommit();
  const receipt = prepared.commit();
  const persistedEngineAuthority = harness.authorityStore.load("host-local-inference");
  expect(persistedEngineAuthority).not.toBeNull();
  return { harness, runtime, receipt, persistedEngineAuthority: persistedEngineAuthority! };
}

describe("Podman published Ollama readiness inspection", () => {
  it("classifies one exact running runtime through one receipt-bound inspection", () => {
    const { harness, receipt, persistedEngineAuthority } = publishedRuntime();
    const assertCurrent = vi.fn();
    harness.events.length = 0;

    expect(
      inspectPodmanPublishedOllamaReadinessRuntime({
        engine: harness.engine,
        persistedEngineAuthority,
        serializedReceipt: serializeHostLocalInferenceReceipt(receipt),
        assertCurrent,
      }),
    ).toMatchObject({ running: true, receipt });

    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(harness.events.filter((event) => event.includes("container inspect"))).toHaveLength(1);
    expect(harness.events.join("\n")).not.toMatch(/\b(?:version|info)\b/u);
    expect(harness.events.join("\n")).not.toContain("nvidia-smi");
  });

  it("keeps creation authority immutable across a requalified current endpoint", () => {
    const { harness, receipt, persistedEngineAuthority } = publishedRuntime();
    const currentEngine = Object.freeze({
      ...harness.engine,
      authorityId: "test:current-post-home-endpoint",
      endpointAuthorityId: "test:current-post-home-endpoint",
    });
    const assertCurrent = vi.fn();
    harness.events.length = 0;

    expect(currentEngine.authorityId).not.toBe(persistedEngineAuthority.authorityId);
    expect(
      inspectPodmanPublishedOllamaReadinessRuntime({
        engine: currentEngine,
        persistedEngineAuthority,
        serializedReceipt: serializeHostLocalInferenceReceipt(receipt),
        assertCurrent,
      }),
    ).toMatchObject({ running: true, receipt });

    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(harness.events.filter((event) => event.includes("container inspect"))).toHaveLength(1);
    expect(harness.events.join("\n")).not.toMatch(/\b(?:version|info|start|stop|nvidia-smi)\b/u);
  });

  it.each([
    ["provider", { engineId: "docker" }],
    ["operation", { operation: "host-doctor" }],
  ] as const)("rejects a current engine with another %s", (_label, change) => {
    const { harness, receipt, persistedEngineAuthority } = publishedRuntime();
    const currentEngine = Object.freeze({ ...harness.engine, ...change });
    harness.events.length = 0;

    expect(() =>
      inspectPodmanPublishedOllamaReadinessRuntime({
        engine: currentEngine as typeof harness.engine,
        persistedEngineAuthority,
        serializedReceipt: serializeHostLocalInferenceReceipt(receipt),
        assertCurrent: vi.fn(),
      }),
    ).toThrow("Podman published readiness engine authority is invalid.");

    expect(harness.events).toHaveLength(0);
  });

  it("rejects a changed creation authority before inspecting the current runtime", () => {
    const { harness, receipt, persistedEngineAuthority } = publishedRuntime();
    harness.events.length = 0;

    expect(() =>
      inspectPodmanPublishedOllamaReadinessRuntime({
        engine: harness.engine,
        persistedEngineAuthority: {
          ...persistedEngineAuthority,
          bindingSha256: "a".repeat(64),
        },
        serializedReceipt: serializeHostLocalInferenceReceipt(receipt),
        assertCurrent: vi.fn(),
      }),
    ).toThrow("Podman published readiness engine authority changed.");

    expect(harness.events).toHaveLength(0);
  });

  it("rejects current endpoint drift before the exact inspection", () => {
    const { harness, receipt, persistedEngineAuthority } = publishedRuntime();
    const assertCurrent = vi.fn(() => {
      throw new Error("current endpoint changed");
    });
    harness.events.length = 0;

    expect(() =>
      inspectPodmanPublishedOllamaReadinessRuntime({
        engine: harness.engine,
        persistedEngineAuthority,
        serializedReceipt: serializeHostLocalInferenceReceipt(receipt),
        assertCurrent,
      }),
    ).toThrow("current endpoint changed");

    expect(harness.events).toHaveLength(0);
  });

  it("rejects current endpoint drift after the exact inspection", () => {
    const { harness, receipt, persistedEngineAuthority } = publishedRuntime();
    const assertCurrent = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("current endpoint changed");
      });
    harness.events.length = 0;

    expect(() =>
      inspectPodmanPublishedOllamaReadinessRuntime({
        engine: harness.engine,
        persistedEngineAuthority,
        serializedReceipt: serializeHostLocalInferenceReceipt(receipt),
        assertCurrent,
      }),
    ).toThrow("current endpoint changed");

    expect(harness.events.filter((event) => event.includes("container inspect"))).toHaveLength(1);
  });

  it("classifies one exact stopped runtime without starting it", () => {
    const { harness, runtime, receipt, persistedEngineAuthority } = publishedRuntime();
    runtime.stopManaged(receipt);
    harness.events.length = 0;

    expect(
      inspectPodmanPublishedOllamaReadinessRuntime({
        engine: harness.engine,
        persistedEngineAuthority,
        serializedReceipt: serializeHostLocalInferenceReceipt(receipt),
        assertCurrent: vi.fn(),
      }),
    ).toMatchObject({ running: false, receipt });

    expect(harness.events.filter((event) => event.includes("container inspect"))).toHaveLength(1);
    expect(harness.events.join("\n")).not.toMatch(/\b(?:start|stop|version|info)\b/u);
  });

  it.each([
    [
      "network",
      (harness: ReturnType<typeof createPodmanHostLocalInferenceTestHarness>) => {
        const container = harness.container()! as { createArguments: readonly string[] };
        container.createArguments = container.createArguments.map((argument, index, args) =>
          args[index - 1] === "--network" ? "changed-network" : argument,
        );
      },
    ],
    [
      "container",
      (harness: ReturnType<typeof createPodmanHostLocalInferenceTestHarness>) => {
        (harness.container()! as { imageRef: string }).imageRef =
          "registry.test/changed@sha256:bad";
      },
    ],
  ] as const)("rejects exact %s drift through the single inspection", (_label, mutate) => {
    const { harness, receipt, persistedEngineAuthority } = publishedRuntime();
    mutate(harness);
    harness.events.length = 0;

    expect(() =>
      inspectPodmanPublishedOllamaReadinessRuntime({
        engine: harness.engine,
        persistedEngineAuthority,
        serializedReceipt: serializeHostLocalInferenceReceipt(receipt),
        assertCurrent: vi.fn(),
      }),
    ).toThrow();

    expect(harness.events.filter((event) => event.includes("container inspect"))).toHaveLength(1);
    expect(harness.events.join("\n")).not.toMatch(/\b(?:start|stop|version|info)\b/u);
  });
});
