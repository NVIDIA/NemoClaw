// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createPodmanHostLocalInferenceTestHarness } from "../../../../test/helpers/podman-host-local-inference-test-harness";
import type { HostLocalInferenceRuntime } from "./host-local-inference";
import {
  createPodmanHostLocalInferenceOperation,
  createPodmanHostLocalInferenceRuntime,
} from "./podman-host-local-inference";
import { qualifyPodmanInferenceAuthority } from "./podman-preflight";

const OLLAMA_MODEL_SIZE = 8 * 1024 ** 3;
const OLLAMA_MODEL_DIGEST = "7".repeat(64);

function ollamaPsModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "nemotron:latest",
    model: "nemotron:latest",
    size: OLLAMA_MODEL_SIZE,
    size_vram: OLLAMA_MODEL_SIZE,
    digest: OLLAMA_MODEL_DIGEST,
    ...overrides,
  };
}

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
  expect(operation.managedRuntime).toBeDefined();
  return operation.managedRuntime as HostLocalInferenceRuntime;
}

describe("Podman host-local inference acceleration authority", () => {
  it("rejects malformed operation acceleration before any provider command", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.events.length = 0;

    expect(() =>
      createPodmanHostLocalInferenceOperation({
        engine: harness.engine,
        env: harness.env,
        acceleration: "tpu" as never,
        probeCleanupTiming: harness.probeCleanupTiming,
        authorityStore: harness.authorityStore,
        routeAuthorityStore: harness.routeAuthorityStore,
        onFailureEvidence: harness.onFailureEvidence,
        redactSensitive: harness.redactSensitive,
      }),
    ).toThrow("operation acceleration is unsupported");
    expect(harness.events).toHaveLength(0);
  });

  it("rejects malformed direct-runtime acceleration before any provider command", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const authority = qualifyPodmanInferenceAuthority(harness.engine);
    harness.events.length = 0;

    expect(() =>
      createPodmanHostLocalInferenceRuntime({
        engine: harness.engine,
        env: harness.env,
        probeCleanupTiming: harness.probeCleanupTiming,
        authorityStore: harness.authorityStore,
        routeAuthorityStore: harness.routeAuthorityStore,
        authority,
        operationAcceleration: "tpu" as never,
        onFailureEvidence: harness.onFailureEvidence,
        redactSensitive: harness.redactSensitive,
      }),
    ).toThrow("operation acceleration is unsupported");
    expect(harness.events).toHaveLength(0);
  });

  it("proves explicit CPU-only Ollama use before publication", () => {
    const harness = createPodmanHostLocalInferenceTestHarness({
      acceleration: "cpu",
      cdiDevices: [],
      omitDiscoveredDevices: true,
    });
    harness.state.ollamaPsModels = [
      ollamaPsModel({ name: "other:latest", model: "other:latest" }),
      ollamaPsModel({ size_vram: 0 }),
    ];
    const runtime = operationRuntime(harness);
    harness.events.length = 0;

    const prepared = runtime.qualifyOllama(
      {
        acceleration: "cpu",
        networkName: harness.input.networkName,
        networkId: harness.input.networkId,
        networkGatewayIp: harness.input.networkGatewayIp,
        hostPort: 11434,
        probeImageRef: harness.input.probeImageRef,
        model: "nemotron:latest",
        requireToolCalling: true,
      },
      harness.writer,
    );

    expect(prepared.receipt.runtime).toMatchObject({ kind: "host", acceleration: "cpu" });
    expect(harness.events.findIndex((event) => event.includes("/api/ps"))).toBeGreaterThan(
      harness.events.findIndex((event) => event.includes("/v1/chat/completions")),
    );
    prepared.validateBeforeCommit();
    expect(prepared.commit()).toEqual(prepared.receipt);
  });

  it.each([
    ["omitted inventory", { cdiDevices: [], omitDiscoveredDevices: true }],
    ["explicit empty inventory", { cdiDevices: [] }],
    ["non-NVIDIA-only inventory", { cdiDevices: ["vendor.example/accelerator=0"] }],
  ] as const)("rejects NVIDIA GPU operation scope with %s", (_label, options) => {
    const harness = createPodmanHostLocalInferenceTestHarness(options);

    expect(() => operationRuntime(harness)).toThrow(
      "requires at least one discovered NVIDIA CDI device",
    );
    expect(harness.events.some((event) => event.startsWith("podman:run "))).toBe(false);
  });

  it("rejects exact CPU CDI drift before publication and retains the host process", () => {
    const harness = createPodmanHostLocalInferenceTestHarness({
      acceleration: "cpu",
      cdiDevices: [],
      omitDiscoveredDevices: true,
    });
    harness.state.ollamaPsModels = [ollamaPsModel({ size_vram: 0 })];
    const runtime = operationRuntime(harness);
    const prepared = runtime.qualifyOllama(
      {
        acceleration: "cpu",
        networkName: harness.input.networkName,
        networkId: harness.input.networkId,
        networkGatewayIp: harness.input.networkGatewayIp,
        hostPort: 11434,
        probeImageRef: harness.input.probeImageRef,
        model: "nemotron:latest",
        requireToolCalling: true,
      },
      harness.writer,
    );
    harness.state.omitDiscoveredDevices = false;
    harness.state.cdiDevices = ["nvidia.com/gpu=all"];

    expect(() => prepared.validateBeforeCommit()).toThrow("server or NVIDIA CDI authority changed");
    expect(harness.routeAuthorityStore.load("ollama")).toBeNull();
    expect(harness.written).toHaveLength(0);
    expect(prepared.rollback()).toMatchObject({ status: "retained", priorState: "host-process" });
  });

  it.each([
    ["cpu", "nvidia-gpu"],
    ["nvidia-gpu", "cpu"],
  ] as const)(
    "rejects a %s Ollama receipt through a %s operation without provider mutation",
    (receiptAcceleration, validationAcceleration) => {
      const harness = createPodmanHostLocalInferenceTestHarness({
        acceleration: receiptAcceleration,
      });
      harness.state.ollamaPsModels = [
        ollamaPsModel({
          size_vram: receiptAcceleration === "cpu" ? 0 : OLLAMA_MODEL_SIZE,
        }),
      ];
      const sourceRuntime = operationRuntime(harness);
      const prepared = sourceRuntime.qualifyOllama(
        {
          acceleration: receiptAcceleration,
          networkName: harness.input.networkName,
          networkId: harness.input.networkId,
          networkGatewayIp: harness.input.networkGatewayIp,
          hostPort: 11434,
          probeImageRef: harness.input.probeImageRef,
          model: "nemotron:latest",
          requireToolCalling: true,
        },
        harness.writer,
      );
      prepared.validateBeforeCommit();
      prepared.commit();
      const validationRuntime = createPodmanHostLocalInferenceRuntime({
        engine: harness.engine,
        env: harness.env,
        probeCleanupTiming: harness.probeCleanupTiming,
        authorityStore: harness.authorityStore,
        routeAuthorityStore: harness.routeAuthorityStore,
        authority: qualifyPodmanInferenceAuthority(harness.engine),
        operationAcceleration: validationAcceleration,
        onFailureEvidence: harness.onFailureEvidence,
        redactSensitive: harness.redactSensitive,
      });
      harness.events.length = 0;
      expect(validationRuntime.validate).toBeTypeOf("function");
      const validate = validationRuntime.validate as NonNullable<
        HostLocalInferenceRuntime["validate"]
      >;

      expect(() => validate(prepared.receipt)).toThrow(
        "receipt acceleration differs from its operation authority",
      );
      expect(harness.events).toHaveLength(0);
    },
  );

  it("rejects managed lifecycle and GPU translation through CPU operation authority", () => {
    const harness = createPodmanHostLocalInferenceTestHarness({ acceleration: "cpu" });
    const runtime = operationRuntime(harness);
    harness.events.length = 0;

    expect(runtime.services).toEqual(["ollama"]);
    expect(() => runtime.startManaged(harness.input, harness.writer)).toThrow(
      "require NVIDIA GPU operation authority",
    );
    expect(() =>
      runtime.translateContainerArgs(["run", "--gpus", "all", harness.input.imageRef]),
    ).toThrow("CPU authority forbids GPU attachment");
    expect(harness.events.some((event) => event.startsWith("podman:run "))).toBe(false);
  });

  it.each([
    ["missing exact model", [], "exactly one exact-model entry", "nvidia-gpu"],
    [
      "tag alias",
      [ollamaPsModel({ name: "nemotron", model: "nemotron" })],
      "exactly one exact-model entry",
      "nvidia-gpu",
    ],
    [
      "partial identity collision",
      [ollamaPsModel({ model: "other:latest" })],
      "exactly one exact-model entry",
      "nvidia-gpu",
    ],
    [
      "duplicate exact model",
      [ollamaPsModel(), ollamaPsModel()],
      "exactly one exact-model entry",
      "nvidia-gpu",
    ],
    [
      "malformed size_vram",
      [ollamaPsModel({ size_vram: "1024" })],
      "malformed size_vram authority",
      "nvidia-gpu",
    ],
    [
      "unbounded size_vram",
      [ollamaPsModel({ size_vram: Number.MAX_SAFE_INTEGER + 1 })],
      "malformed size_vram authority",
      "nvidia-gpu",
    ],
    [
      "negative size_vram",
      [ollamaPsModel({ size_vram: -1 })],
      "malformed size_vram authority",
      "nvidia-gpu",
    ],
    [
      "fractional size_vram",
      [ollamaPsModel({ size_vram: 0.5 })],
      "malformed size_vram authority",
      "nvidia-gpu",
    ],
    [
      "malformed size",
      [ollamaPsModel({ size: "8589934592" })],
      "malformed size authority",
      "nvidia-gpu",
    ],
    [
      "partial GPU offload",
      [ollamaPsModel({ size_vram: OLLAMA_MODEL_SIZE / 2 })],
      "complete provider-native NVIDIA GPU offload",
      "nvidia-gpu",
    ],
    [
      "malformed model digest",
      [ollamaPsModel({ digest: `sha256:${OLLAMA_MODEL_DIGEST}` })],
      "malformed model digest authority",
      "nvidia-gpu",
    ],
    ["non-object model", ["nemotron:latest"], "must be an object", "nvidia-gpu"],
    [
      "oversized model list",
      Array.from({ length: 1025 }, (_, index) => ({
        name: `other-${String(index)}`,
        model: `other-${String(index)}`,
        size: OLLAMA_MODEL_SIZE,
        size_vram: 0,
        digest: OLLAMA_MODEL_DIGEST,
      })),
      "bounded provider-native model list",
      "nvidia-gpu",
    ],
    [
      "GPU fallback",
      [ollamaPsModel({ size_vram: 0 })],
      "complete provider-native NVIDIA GPU offload",
      "nvidia-gpu",
    ],
  ] as const)("fails closed on Ollama %s", (_case, models, expected, acceleration) => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.ollamaPsModels = [...models];
    const runtime = operationRuntime(harness);

    expect(() =>
      runtime.qualifyOllama(
        {
          acceleration,
          networkName: harness.input.networkName,
          networkId: harness.input.networkId,
          networkGatewayIp: harness.input.networkGatewayIp,
          hostPort: 11434,
          probeImageRef: harness.input.probeImageRef,
          model: "nemotron:latest",
          requireToolCalling: true,
        },
        harness.writer,
      ),
    ).toThrow(expected);
    expect(harness.failures.at(-1)).toMatchObject({ phase: "gpu" });
    expect(harness.routeAuthorityStore.load("ollama")).toBeNull();
    expect(harness.written).toHaveLength(0);
    expect(harness.events.some((event) => event.startsWith("podman:start "))).toBe(false);
    expect(harness.events.some((event) => event.startsWith("podman:stop "))).toBe(false);
  });

  it("fails closed when provider-native CPU placement drifts to GPU use", () => {
    const harness = createPodmanHostLocalInferenceTestHarness({ acceleration: "cpu" });
    harness.state.ollamaPsModels = [ollamaPsModel()];
    const runtime = operationRuntime(harness);

    expect(() =>
      runtime.qualifyOllama(
        {
          acceleration: "cpu",
          networkName: harness.input.networkName,
          networkId: harness.input.networkId,
          networkGatewayIp: harness.input.networkGatewayIp,
          hostPort: 11434,
          probeImageRef: harness.input.probeImageRef,
          model: "nemotron:latest",
          requireToolCalling: true,
        },
        harness.writer,
      ),
    ).toThrow("GPU use for a CPU route");
    expect(harness.failures.at(-1)).toMatchObject({ phase: "gpu" });
    expect(harness.routeAuthorityStore.load("ollama")).toBeNull();
    expect(harness.written).toHaveLength(0);
  });
});
