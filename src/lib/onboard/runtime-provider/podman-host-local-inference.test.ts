// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createPodmanHostLocalInferenceTestHarness } from "../../../../test/helpers/podman-host-local-inference-test-harness";
import type {
  HostLocalInferenceRuntime,
  HostLocalManagedInferenceInput,
} from "./host-local-inference";
import {
  createPodmanHostLocalInferenceOperation,
  createPodmanHostLocalInferenceRuntime,
  PODMAN_INFERENCE_PROBE_MANAGED_LABEL,
} from "./podman-host-local-inference";
import { qualifyPodmanInferenceAuthority } from "./podman-preflight";

const OLLAMA_MODEL_SIZE = 8 * 1024 ** 3;
const OLLAMA_MODEL_DIGEST = "7".repeat(64);
const PROVIDER_FAILURE_SECRETS = [
  "nvapi-1234567890abcdef",
  "bearer-secret-1234",
  "environment-secret",
  "user:pass",
  "query-secret",
] as const;

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

function operationAndRuntime(
  harness: ReturnType<typeof createPodmanHostLocalInferenceTestHarness>,
): {
  operation: ReturnType<typeof createPodmanHostLocalInferenceOperation>;
  runtime: HostLocalInferenceRuntime;
} {
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
  const runtime =
    operation.managedRuntime ??
    (() => {
      throw new Error("test operation lacks managed runtime");
    })();
  return { operation, runtime };
}

function operationRuntime(
  harness: ReturnType<typeof createPodmanHostLocalInferenceTestHarness>,
): HostLocalInferenceRuntime {
  return operationAndRuntime(harness).runtime;
}

describe("Podman host-local inference lifecycle", () => {
  it("keeps the raw Podman command boundary private to the managed lifecycle", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const operation = createPodmanHostLocalInferenceOperation({
      engine: harness.engine,
      env: harness.env,
      probeCleanupTiming: harness.probeCleanupTiming,
      authorityStore: harness.authorityStore,
      routeAuthorityStore: harness.routeAuthorityStore,
      onFailureEvidence: harness.onFailureEvidence,
      redactSensitive: harness.redactSensitive,
    });
    harness.events.length = 0;
    expect(() => operation.engine.capture(["run", "--privileged"])).toThrow(
      "provider-owned lifecycle",
    );
    expect(() => operation.engine.captureHost(["info"])).toThrow("provider-owned lifecycle");
    expect(() =>
      operation.engine.captureWithEnvironment?.(["run"], { NGC_API_KEY: "opaque" }),
    ).toThrow("provider-owned lifecycle");
    expect(harness.events).toHaveLength(0);
  });

  it.each(["nim", "vllm"] as const)(
    "proves and publishes a secret-free canonical %s receipt in exact order",
    (service) => {
      const harness = createPodmanHostLocalInferenceTestHarness({ service });
      const runtime = operationRuntime(harness);
      harness.events.length = 0;

      const prepared = runtime.startManaged(harness.input, harness.writer);

      expect(prepared.receipt).toMatchObject({
        schemaVersion: 2,
        providerId: "podman",
        service,
        endpoint: { host: "host.openshell.internal" },
        inference: {
          protocol: "openai-chat-completions",
          model: `${service}-model`,
          toolCallingRequired: true,
        },
        publication: { priorState: "absent" },
      });
      expect(harness.written).toHaveLength(0);
      expect(
        Object.values(harness.env)
          .map(String)
          .filter((secret) => secret.length > 0)
          .filter((secret) => harness.events.join("\n").includes(secret)),
      ).toEqual([]);
      expect(JSON.stringify(prepared.receipt)).not.toContain("test-secret");

      const firstReady = harness.events.findIndex((event) =>
        event.includes(service === "nim" ? "/v1/health/ready" : "/health"),
      );
      const firstGpu = harness.events.findIndex((event) => event.includes("nvidia-smi"));
      const firstInference = harness.events.findIndex((event) =>
        event.includes("/v1/chat/completions"),
      );
      expect(firstReady).toBeGreaterThanOrEqual(0);
      expect(firstGpu).toBeGreaterThan(firstReady);
      expect(firstInference).toBeGreaterThan(firstGpu);
      expect(harness.events.filter((event) => event.startsWith("environment:"))).toEqual(
        service === "nim" ? ["environment:NGC_API_KEY"] : [],
      );
      expect(harness.events.join("\n")).not.toContain("docker");

      prepared.validateBeforeCommit();
      expect(harness.written).toHaveLength(0);
      expect(prepared.commit()).toEqual(prepared.receipt);
      expect(harness.written).toHaveLength(1);
      expect(harness.events.at(-1)).toBe("receipt:write");
    },
  );

  it("accepts whitespace in the provider-native empty tool arguments object", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.toolArguments = " \n { \n } \t";
    const runtime = operationRuntime(harness);

    const prepared = runtime.startManaged(harness.input, harness.writer);

    expect(prepared.receipt.inference).toMatchObject({ toolCallingRequired: true });
    expect(harness.probe()).toBeNull();
    expect(harness.container()).toMatchObject({ running: true });
  });

  it.each([
    ["malformed", "{"],
    ["an array", "[]"],
    ["null", "null"],
    ["a nonempty object", '{"unexpected":true}'],
  ] as const)("rejects %s provider-native tool arguments", (_label, toolArguments) => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.toolArguments = toolArguments;
    const runtime = operationRuntime(harness);

    expect(() => runtime.startManaged(harness.input, harness.writer)).toThrow(
      "did not return the required tool call",
    );
    expect(harness.failures.at(-1)).toMatchObject({ phase: "inference" });
    expect(harness.probe()).toBeNull();
    expect(harness.container()).toBeNull();
    expect(harness.written).toHaveLength(0);
  });

  it("uses exact named disposable probes with no anonymous or cross-authority launch surface", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeInheritedImageLabel = true;
    const runtime = operationRuntime(harness);
    harness.events.length = 0;

    runtime.startManaged(harness.input, harness.writer);

    const probeRuns = harness.events.filter(
      (event) =>
        event.startsWith("podman:run ") &&
        event.includes(`${PODMAN_INFERENCE_PROBE_MANAGED_LABEL}=true`),
    );
    expect(probeRuns).toHaveLength(2);
    probeRuns.forEach((run) => {
      expect(run).toContain("--detach");
      expect(run).toContain("--read-only");
      expect(run).toContain("--ipc private");
      expect(run).toContain("--http-proxy=false");
      expect(run).not.toContain(" --rm");
      expect(run).not.toContain("--publish");
      expect(run).not.toContain("--device");
      expect(run).not.toContain("--env");
      expect(run).not.toContain("--restart");
      expect(run).not.toContain("host.containers.internal");
      expect(run).not.toContain("host.openshell.internal");
      expect(run).toContain(harness.input.networkGatewayIp);
    });
    expect(harness.probe()).toBeNull();
    expect(harness.container()).toMatchObject({ running: true });
  });

  it("allows ordinary inherited image labels on the managed parent", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.parentInheritedImageLabel = true;
    const runtime = operationRuntime(harness);

    expect(runtime.startManaged(harness.input, harness.writer).receipt.service).toBe("nim");
    expect(harness.container()?.labels).toHaveProperty("org.opencontainers.image.source");
  });

  it("rejects an extra controlled-namespace label on the managed parent", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.parentExtraControlledLabel = true;
    const runtime = operationRuntime(harness);

    expect(() => runtime.startManaged(harness.input, harness.writer)).toThrow(
      "does not match its exact managed authority",
    );
    expect(harness.container()).toBeNull();
    expect(harness.written).toHaveLength(0);
  });

  it("accepts a lost disposable-probe create acknowledgement only after exact exit and absence proof", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeRunLostAcknowledgement = true;
    const runtime = operationRuntime(harness);

    const prepared = runtime.startManaged(harness.input, harness.writer);

    expect(prepared.receipt.service).toBe("nim");
    expect(harness.probe()).toBeNull();
    expect(
      harness.failures.some(({ message }) => message.includes("probe create returned exit")),
    ).toBe(true);
  });

  it("uses a valid full container ID when probe name lookup would time out (#9211)", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probePostCreateNameLookupTimeout = true;
    expect(() =>
      operationRuntime(harness).startManaged(harness.input, harness.writer),
    ).not.toThrow();
  });

  it("captures a malformed disposable-probe create acknowledgement and removes all residue", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeRunAcknowledgementText = "not-a-full-container-id";
    const runtime = operationRuntime(harness);

    expect(() => runtime.startManaged(harness.input, harness.writer)).toThrow(
      "must be a full immutable ID",
    );
    expect(
      harness.failures.some(
        ({ phase, message }) =>
          phase === "ready" && message.includes("must be a full immutable ID"),
      ),
    ).toBe(true);
    expect(harness.failureProbeIds[0]).toBe("c".repeat(64));
    expect(harness.probe()).toBeNull();
    expect(harness.container()).toBeNull();
  });

  it.each([
    ["after create", 1, ["wait", "logs", "rm"], "probe identity is indeterminate after create"],
    ["during cleanup", 3, ["rm"], "probe cleanup lost exact identity"],
  ] as const)(
    "rejects a Podman inspect result whose container ID differs from the queried ID %s (#9211)",
    (_stage, at, forbiddenActions, expectedFailure) => {
      const harness = createPodmanHostLocalInferenceTestHarness();
      harness.state.probeInspectRuntimeIdMismatchAt = at;
      harness.state.probeForbiddenActions = [...forbiddenActions];
      const runtime = operationRuntime(harness);

      expect(() => runtime.startManaged(harness.input, harness.writer)).toThrow(expectedFailure);
      expect(harness.probe()).toMatchObject({ id: "c".repeat(64) });
    },
  );

  it("accepts a lost disposable-probe remove acknowledgement only after exact absence proof", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeRemoveLostAcknowledgement = true;
    const runtime = operationRuntime(harness);

    const prepared = runtime.startManaged(harness.input, harness.writer);

    expect(prepared.receipt.service).toBe("nim");
    expect(harness.probe()).toBeNull();
    expect(harness.container()).toMatchObject({ running: true });
    expect(
      harness.failures.some(
        ({ message }) =>
          message.includes("probe removal returned exit 125") &&
          message.includes("transport closed after probe remove"),
      ),
    ).toBe(true);
    expect(harness.written).toHaveLength(0);
  });

  it("retains an already-present deterministic probe name without trusting copyable labels", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeRemoveLeavesContainer = true;
    const runtime = operationRuntime(harness);
    expect(() => runtime.startManaged(harness.input, harness.writer)).toThrow(
      "probe cleanup is indeterminate",
    );
    expect(harness.probe()).not.toBeNull();
    harness.state.probeRemoveLeavesContainer = false;
    harness.events.length = 0;

    expect(() => runtime.startManaged(harness.input, harness.writer)).toThrow(
      "requires exact durable cleanup authority",
    );
    expect(harness.probe()).not.toBeNull();
    expect(
      harness.events.some((event) => event.includes(`podman:rm --force ${"c".repeat(64)}`)),
    ).toBe(false);
    expect(harness.container()).toBeNull();
  });

  it("stops and removes an exact timed-out probe before restoring the new parent runtime", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeWaitFailure = true;
    const runtime = operationRuntime(harness);

    expect(() => runtime.startManaged(harness.input, harness.writer)).toThrow("probe wait failed");
    expect(harness.probe()).toBeNull();
    expect(harness.container()).toBeNull();
    const evidence = harness.events.indexOf("evidence:ready");
    const probeStop = harness.events.findIndex((event) =>
      event.includes(`podman:stop --time 30 ${"c".repeat(64)}`),
    );
    const parentRemove = harness.events.findIndex((event) =>
      event.includes(`podman:rm --force ${"a".repeat(64)}`),
    );
    expect(probeStop).toBeGreaterThan(evidence);
    expect(parentRemove).toBeGreaterThan(probeStop);
  });

  it.each([
    ["absent", null],
    ["running", true],
    ["stopped", false],
  ] as const)(
    "fails closed on indeterminate probe cleanup and restores the exact %s parent state",
    (priorState, expectedRunning) => {
      const harness = createPodmanHostLocalInferenceTestHarness();
      const operation = createPodmanHostLocalInferenceOperation({
        engine: harness.engine,
        env: harness.env,
        probeCleanupTiming: harness.probeCleanupTiming,
        authorityStore: harness.authorityStore,
        routeAuthorityStore: harness.routeAuthorityStore,
        onFailureEvidence: harness.onFailureEvidence,
        redactSensitive: harness.redactSensitive,
      });
      const runtime = operation.managedRuntime!;
      const seedPriorState = {
        absent: () => undefined,
        running: () => harness.seedManaged("running", true, operation.bindingSha256),
        stopped: () => harness.seedManaged("stopped", false, operation.bindingSha256),
      } as const;
      seedPriorState[priorState]();
      harness.state.probeRemoveLeavesContainer = true;
      harness.events.length = 0;

      const action = () =>
        priorState === "absent"
          ? runtime.startManaged(harness.input, harness.writer)
          : runtime.recoverManaged?.(harness.input, harness.writer);
      expect(action).toThrow("probe cleanup is indeterminate");
      expect(harness.container()?.running ?? null).toBe(expectedRunning);
      expect(harness.probe()).not.toBeNull();
      expect(harness.written).toHaveLength(0);
    },
  );

  it("fails closed when a disposable probe name is reused after exact-ID removal", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeReuseNameAfterRemoval = true;
    const runtime = operationRuntime(harness);

    expect(() => runtime.startManaged(harness.input, harness.writer)).toThrow(
      "probe cleanup is indeterminate",
    );
    expect(harness.container()).toBeNull();
    expect(harness.probe()).toMatchObject({ id: "d".repeat(64), running: true });
    expect(
      harness.events.some((event) => event.includes(`podman:rm --force ${"d".repeat(64)}`)),
    ).toBe(false);
    expect(harness.written).toHaveLength(0);
  });

  it("keeps precommit probe-cleanup failure rollback-safe and unpublished", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const prepared = runtime.startManaged(harness.input, harness.writer);
    harness.state.probeRemoveLeavesContainer = true;

    expect(() => prepared.validateBeforeCommit()).toThrow("probe cleanup is indeterminate");
    expect(prepared.publicationState()).toBe("unpublished");
    expect(prepared.rollback()).toMatchObject({ status: "removed", priorState: "absent" });
    expect(harness.container()).toBeNull();
    expect(harness.probe()).not.toBeNull();
    expect(harness.written).toHaveLength(0);
  });

  it("reports combined indeterminate evidence when probe and parent cleanup both fail", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeRemoveLeavesContainer = true;
    harness.state.removeLeavesContainer = true;
    const runtime = operationRuntime(harness);

    expect(() => runtime.startManaged(harness.input, harness.writer)).toThrow(
      "Exact prior-runtime restoration also failed",
    );
    expect(harness.container()).not.toBeNull();
    expect(harness.probe()).not.toBeNull();
    expect(harness.written).toHaveLength(0);
  });

  it("snapshots the operation-scoped secret environment before caller mutation", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const original = harness.env.NGC_API_KEY;
    const runtime = operationRuntime(harness);
    harness.env.NGC_API_KEY = "mutated-after-operation-construction";

    runtime.startManaged(harness.input, harness.writer);

    expect(original).toBeTruthy();
    expect(harness.state.capturedEnvironmentValues).toEqual([{ NGC_API_KEY: original }]);
    expect(harness.events.join("\n")).not.toContain("mutated-after-operation-construction");
  });

  it("binds Ollama Ready, real inference, and GPU use before route publication", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    harness.events.length = 0;

    const prepared = runtime.qualifyOllama(
      {
        acceleration: "nvidia-gpu",
        networkName: "nemoclaw-net",
        networkId: harness.input.networkId,
        networkGatewayIp: harness.input.networkGatewayIp,
        hostPort: 11434,
        probeImageRef: harness.input.probeImageRef,
        model: "nemotron:latest",
        requireToolCalling: true,
      },
      harness.writer,
    );

    expect(harness.routeAuthorityStore.load("ollama")).toBeNull();
    expect(harness.written).toHaveLength(0);
    expect(prepared.receipt.runtime).toMatchObject({
      kind: "host",
      acceleration: "nvidia-gpu",
      modelDigest: `sha256:${OLLAMA_MODEL_DIGEST}`,
    });
    const ready = harness.events.findIndex((event) => event.includes("/api/tags"));
    const inference = harness.events.findIndex((event) => event.includes("/v1/chat/completions"));
    const acceleration = harness.events.findIndex((event) => event.includes("/api/ps"));
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(inference).toBeGreaterThan(ready);
    expect(acceleration).toBeGreaterThan(inference);
    expect(harness.events[inference]).toContain('"tool_choice":"required"');
    expect(harness.events[inference]).toContain('"max_tokens":4096');
    expect(harness.events[inference]).toContain('"temperature":0');

    prepared.validateBeforeCommit();
    expect(harness.routeAuthorityStore.load("ollama")).toBeNull();
    const validatedAccelerationProofs = harness.events.filter((event) =>
      event.includes("/api/ps"),
    ).length;
    prepared.commit();
    expect(harness.events.filter((event) => event.includes("/api/ps"))).toHaveLength(
      validatedAccelerationProofs,
    );
    expect(harness.routeAuthorityStore.load("ollama")).toMatchObject({
      providerId: "podman",
      service: "ollama",
    });
    expect(harness.events.slice(-2)).toEqual(["route:record", "receipt:write"]);
    expect(() => prepared.rollback()).toThrow("terminal state 'committed'");
  });

  it("canonicalizes an implicit Ollama tag before provider-native identity proof", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);

    const prepared = runtime.qualifyOllama(
      {
        acceleration: "nvidia-gpu",
        networkName: harness.input.networkName,
        networkId: harness.input.networkId,
        networkGatewayIp: harness.input.networkGatewayIp,
        hostPort: 11434,
        probeImageRef: harness.input.probeImageRef,
        model: "nemotron",
        requireToolCalling: true,
      },
      harness.writer,
    );

    expect(prepared.receipt.inference?.model).toBe("nemotron:latest");
    expect(prepared.receipt.runtime).toMatchObject({
      kind: "host",
      modelDigest: `sha256:${OLLAMA_MODEL_DIGEST}`,
    });
  });

  it("redacts provider-native Ollama acceleration failure before retaining host authority", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeFailure = "gpu";
    const runtime = operationRuntime(harness);
    let thrown = "";

    try {
      runtime.qualifyOllama(
        {
          acceleration: "nvidia-gpu",
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
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }

    expect(thrown).toContain("probe exited 22");
    expect(harness.failures.at(-1)).toMatchObject({ phase: "gpu" });

    expect(PROVIDER_FAILURE_SECRETS.every((secret) => !thrown.includes(secret))).toBe(true);
    const failureEvidence = harness.failures.map(({ message }) => message).join("\n");
    expect(PROVIDER_FAILURE_SECRETS.every((secret) => !failureEvidence.includes(secret))).toBe(
      true,
    );

    expect(harness.routeAuthorityStore.load("ollama")).toBeNull();
    expect(harness.written).toHaveLength(0);
  });

  it("retains the host process and unpublished route when precommit acceleration drifts", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const prepared = runtime.qualifyOllama(
      {
        acceleration: "nvidia-gpu",
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
    harness.state.ollamaPsModels = [ollamaPsModel({ size_vram: 0 })];

    expect(() => prepared.validateBeforeCommit()).toThrow(
      "complete provider-native NVIDIA GPU offload",
    );
    expect(harness.failures.at(-1)).toMatchObject({ phase: "gpu" });
    expect(prepared.publicationState()).toBe("unpublished");
    expect(harness.routeAuthorityStore.load("ollama")).toBeNull();
    expect(harness.written).toHaveLength(0);
    expect(prepared.rollback()).toMatchObject({
      status: "retained",
      priorState: "host-process",
    });
  });

  it("rejects Ollama name reuse when the provider-native model digest drifts", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const prepared = runtime.qualifyOllama(
      {
        acceleration: "nvidia-gpu",
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
    harness.state.ollamaPsModels = [ollamaPsModel({ digest: "8".repeat(64) })];

    expect(() => prepared.validateBeforeCommit()).toThrow("model digest drift");
    expect(harness.failures.at(-1)).toMatchObject({ phase: "gpu" });
    expect(harness.routeAuthorityStore.load("ollama")).toBeNull();
    expect(harness.written).toHaveLength(0);
    expect(prepared.rollback()).toMatchObject({ status: "retained" });
  });

  it("keeps synchronous Ollama publication validation authority-only", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const prepared = runtime.qualifyOllama(
      {
        acceleration: "nvidia-gpu",
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
    const providerProofs = harness.events.filter(
      (event) =>
        event.includes("/api/tags") ||
        event.includes("/v1/chat/completions") ||
        event.includes("/api/ps"),
    ).length;
    harness.state.ollamaPsModels = [ollamaPsModel({ size_vram: OLLAMA_MODEL_SIZE / 2 })];

    expect(prepared.commit()).toEqual(prepared.receipt);
    expect(
      harness.events.filter(
        (event) =>
          event.includes("/api/tags") ||
          event.includes("/v1/chat/completions") ||
          event.includes("/api/ps"),
      ),
    ).toHaveLength(providerProofs);
    expect(harness.routeAuthorityStore.load("ollama")).toMatchObject({
      providerId: "podman",
      service: "ollama",
    });
    expect(harness.written).toHaveLength(1);
    expect(prepared.publicationState()).toBe("published");
  });

  it("redacts provider-native Ollama probe failure from both evidence and thrown diagnostics", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeFailure = "ready";
    const runtime = operationRuntime(harness);
    let thrown = "";

    try {
      runtime.qualifyOllama(
        {
          acceleration: "nvidia-gpu",
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
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }

    expect(thrown).toContain("probe exited 22");

    expect(PROVIDER_FAILURE_SECRETS.every((secret) => !thrown.includes(secret))).toBe(true);
    const failureEvidence = harness.failures.map(({ message }) => message).join("\n");
    expect(PROVIDER_FAILURE_SECRETS.every((secret) => !failureEvidence.includes(secret))).toBe(
      true,
    );

    expect(harness.probe()).toBeNull();
  });

  it.each(["host", "none"])("rejects Ollama probe network mode %s", (networkName) => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    harness.events.length = 0;

    expect(() =>
      runtime.qualifyOllama(
        {
          acceleration: "nvidia-gpu",
          networkName,
          networkId: harness.input.networkId,
          networkGatewayIp: harness.input.networkGatewayIp,
          hostPort: 11434,
          probeImageRef: harness.input.probeImageRef,
          model: "nemotron:latest",
          requireToolCalling: true,
        },
        harness.writer,
      ),
    ).toThrow("must identify an isolated provider-owned network");
    expect(harness.events.some((event) => event.includes(`--network ${networkName}`))).toBe(false);
  });

  it("keeps a new runtime rollback-safe until fresh validation crosses publication", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const prepared = runtime.startManaged(harness.input, harness.writer);

    expect(() => prepared.commit()).toThrow("without fresh validation");
    expect(prepared.rollback()).toMatchObject({ status: "removed", priorState: "absent" });
    expect(harness.container()).toBeNull();
    expect(harness.written).toHaveLength(0);
    expect(() => prepared.rollback()).toThrow("terminal state 'rolled-back'");
  });

  it("retains rollback authority when fresh precommit CDI proof drifts", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const prepared = runtime.startManaged(harness.input, harness.writer);
    harness.state.driftAfterReady = true;

    expect(() => prepared.validateBeforeCommit()).toThrow("authority changed");
    expect(harness.failures.at(-1)).toMatchObject({ phase: "ready" });
    expect(prepared.rollback()).toMatchObject({ status: "removed" });
    expect(harness.container()).toBeNull();
    expect(harness.written).toHaveLength(0);
  });

  it("rejects authority drift after the final real inference proof", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const prepared = runtime.startManaged(harness.input, harness.writer);
    harness.state.driftAfterInference = true;

    expect(() => prepared.validateBeforeCommit()).toThrow("authority changed");
    expect(harness.failures.at(-1)).toMatchObject({ phase: "inference" });
    expect(prepared.rollback()).toMatchObject({ status: "removed" });
    expect(harness.container()).toBeNull();
    expect(harness.written).toHaveLength(0);
  });

  it.each(["nim", "vllm"] as const)(
    "keeps managed %s rollback-safe when CDI drifts before receipt publication",
    (service) => {
      const harness = createPodmanHostLocalInferenceTestHarness({ service });
      const runtime = operationRuntime(harness);
      const prepared = runtime.startManaged(harness.input, harness.writer);
      prepared.validateBeforeCommit();
      harness.state.cdiDevices = ["nvidia.com/gpu=0"];

      expect(() => prepared.commit()).toThrow("authority changed");
      expect(harness.failures.at(-1)).toMatchObject({ phase: "commit" });
      expect(harness.written).toHaveLength(0);
      expect(harness.container()).not.toBeNull();
      expect(prepared.publicationState()).toBe("unpublished");
      expect(prepared.rollback()).toMatchObject({ status: "removed", priorState: "absent" });
      expect(harness.container()).toBeNull();
    },
  );

  it("checks Ollama authority immediately before route and receipt publication", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const prepared = runtime.qualifyOllama(
      {
        acceleration: "nvidia-gpu",
        networkName: "nemoclaw-net",
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
    harness.state.cdiDevices = ["nvidia.com/gpu=0"];

    expect(() => prepared.commit()).toThrow("authority changed");
    expect(harness.routeAuthorityStore.load("ollama")).toBeNull();
    expect(harness.written).toHaveLength(0);
    expect(prepared.publicationState()).toBe("unpublished");
    expect(prepared.rollback()).toMatchObject({ status: "retained", priorState: "host-process" });
  });

  it("forbids rollback when precommit failure evidence cannot be captured", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const authority = qualifyPodmanInferenceAuthority(harness.engine);
    const runtime = createPodmanHostLocalInferenceRuntime({
      engine: harness.engine,
      env: harness.env,
      probeCleanupTiming: harness.probeCleanupTiming,
      authorityStore: harness.authorityStore,
      routeAuthorityStore: harness.routeAuthorityStore,
      authority,
      onFailureEvidence: () => {
        throw new Error("protected evidence sink unavailable");
      },
      redactSensitive: harness.redactSensitive,
    });
    const prepared = runtime.startManaged(harness.input, harness.writer);
    harness.state.driftAfterReady = true;

    expect(() => prepared.validateBeforeCommit()).toThrow("protected evidence sink unavailable");
    expect(() => prepared.rollback()).toThrow("terminal state 'indeterminate'");
    expect(harness.container()).not.toBeNull();
    expect(harness.written).toHaveLength(0);
  });

  it("captures bounded redacted provider failure evidence before exact rollback", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeFailure = "inference";
    const runtime = operationRuntime(harness);

    expect(() => runtime.startManaged(harness.input, harness.writer)).toThrow("<REDACTED>");
    expect(harness.failures).toHaveLength(1);
    const evidence = harness.failures[0]?.message ?? "";

    expect(PROVIDER_FAILURE_SECRETS.every((secret) => !evidence.includes(secret))).toBe(true);

    expect(evidence).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    const evidenceIndex = harness.events.findIndex((event) => event === "evidence:inference");
    const removeIndex = harness.events.reduce(
      (lastIndex, event, index) =>
        event.includes(`podman:rm --force ${"a".repeat(64)}`) ? index : lastIndex,
      -1,
    );
    expect(evidenceIndex).toBeGreaterThanOrEqual(0);
    expect(removeIndex).toBeGreaterThan(evidenceIndex);
    expect(harness.container()).toBeNull();
  });

  it("redacts opaque operation secrets from status-zero semantic mismatch evidence", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const secret = harness.env.NGC_API_KEY ?? "";
    harness.state.runSemanticMismatchText = `runtime reported success with ${secret}`;
    const runtime = operationRuntime(harness);

    expect(() => runtime.startManaged(harness.input, harness.writer)).toThrow("[redacted]");
    expect(secret).not.toBe("");
    expect(harness.failures).toHaveLength(1);
    expect(harness.failures[0]?.message).not.toContain(secret);
    expect(harness.events.join("\n")).not.toContain(secret);
    expect(harness.container()).toBeNull();
  });

  it("fails closed without rollback when required evidence capture fails", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.probeFailure = "ready";
    const authority = qualifyPodmanInferenceAuthority(harness.engine);
    const runtime = createPodmanHostLocalInferenceRuntime({
      engine: harness.engine,
      env: harness.env,
      probeCleanupTiming: harness.probeCleanupTiming,
      authorityStore: harness.authorityStore,
      routeAuthorityStore: harness.routeAuthorityStore,
      authority,
      redactSensitive: harness.redactSensitive,
      onFailureEvidence: () => {
        throw new Error("protected evidence sink unavailable");
      },
    });

    expect(() => runtime.startManaged(harness.input, harness.writer)).toThrow(
      "capture failed before rollback",
    );
    expect(harness.container()).not.toBeNull();
    expect(
      harness.events.some((event) => event.includes(`podman:rm --force ${"a".repeat(64)}`)),
    ).toBe(false);
  });

  it("recovers an exact runtime after a lost create acknowledgement", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.runLostAcknowledgement = true;
    const runtime = operationRuntime(harness);

    const prepared = runtime.startManaged(harness.input, harness.writer);
    expect(harness.container()).toMatchObject({ running: true });
    expect(prepared.receipt.runtime).toMatchObject({ runtimeId: "a".repeat(64) });
    expect(harness.failures.at(-1)).toMatchObject({
      phase: "start",
      message: expect.stringContaining("transport closed after create"),
    });
    const runIndex = harness.events.findIndex((event) =>
      event.startsWith("podman:run --http-proxy=false --detach"),
    );
    const evidenceIndex = harness.events.indexOf("evidence:start");
    const readyIndex = harness.events.findIndex((event) => event.includes("/v1/health/ready"));
    expect(evidenceIndex).toBeGreaterThan(runIndex);
    expect(readyIndex).toBeGreaterThan(evidenceIndex);
    expect(prepared.rollback()).toMatchObject({ status: "removed", priorState: "absent" });
  });

  it.each([
    ["malformed", "not-a-full-container-id", "must be a full immutable ID"],
    ["a different full ID", `${"b".repeat(64)}\n`, "disagrees with exact name inspection"],
  ] as const)(
    "captures %s successful managed create acknowledgement and removes all residue",
    (_label, acknowledgement, expectedFailure) => {
      const harness = createPodmanHostLocalInferenceTestHarness();
      harness.state.runAcknowledgementText = acknowledgement;
      const runtime = operationRuntime(harness);

      expect(() => runtime.startManaged(harness.input, harness.writer)).toThrow(expectedFailure);
      expect(
        harness.failures.some(
          ({ phase, message }) => phase === "start" && message.includes(expectedFailure),
        ),
      ).toBe(true);
      const evidenceIndex = harness.events.indexOf("evidence:start");
      const removeIndex = harness.events.findIndex((event) =>
        event.includes(`podman:rm --force ${"a".repeat(64)}`),
      );
      expect(evidenceIndex).toBeGreaterThanOrEqual(0);
      expect(removeIndex).toBeGreaterThan(evidenceIndex);
      expect(harness.container()).toBeNull();
      expect(harness.probe()).toBeNull();
      expect(harness.written).toHaveLength(0);
    },
  );

  it("captures a lost start acknowledgement before recovery proof and restores stopped state", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const operation = createPodmanHostLocalInferenceOperation({
      engine: harness.engine,
      env: harness.env,
      probeCleanupTiming: harness.probeCleanupTiming,
      authorityStore: harness.authorityStore,
      routeAuthorityStore: harness.routeAuthorityStore,
      onFailureEvidence: harness.onFailureEvidence,
      redactSensitive: harness.redactSensitive,
    });
    const runtime = operation.managedRuntime!;
    harness.seedManaged("stopped", false, operation.bindingSha256);
    harness.state.startLostAcknowledgement = true;
    harness.events.length = 0;
    const prepared = runtime.recoverManaged!(harness.input, harness.writer);
    expect(harness.failures.at(-1)).toMatchObject({ phase: "start" });
    const startIndex = harness.events.findIndex((event) => event.startsWith("podman:start "));
    const evidenceIndex = harness.events.indexOf("evidence:start");
    const readyIndex = harness.events.findIndex((event) => event.includes("/v1/health/ready"));
    expect(evidenceIndex).toBeGreaterThan(startIndex);
    expect(readyIndex).toBeGreaterThan(evidenceIndex);
    expect(prepared.rollback()).toMatchObject({ status: "restored", priorState: "stopped" });
    expect(harness.container()).toMatchObject({ running: false, status: "exited" });
  });

  it("requires the recovery entry point for an exact existing transaction", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    runtime.startManaged(harness.input, harness.writer);

    expect(() => runtime.startManaged(harness.input, harness.writer)).toThrow(
      "same-transaction recovery is required",
    );
    const recovered = runtime.recoverManaged?.(harness.input, harness.writer);
    expect(recovered).toBeDefined();
    expect(recovered?.rollback()).toMatchObject({ status: "removed", priorState: "absent" });
  });

  it("resumes a published running runtime without inheriting its original absent rollback state", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const initial = runtime.startManaged(harness.input, harness.writer);
    initial.validateBeforeCommit();
    const receipt = initial.commit();
    harness.events.length = 0;

    const resumed = runtime.resumeManaged?.(harness.input, receipt, harness.writer);

    expect(resumed).toBeDefined();
    expect(resumed?.rollbackPriorState).toBe("running");
    expect(resumed?.receipt).toEqual(receipt);
    expect(resumed?.rollback()).toMatchObject({ status: "restored", priorState: "running" });
    expect(harness.container()).toMatchObject({ running: true });
    expect(
      harness.events.some((event) => event.includes(`podman:rm --force ${"a".repeat(64)}`)),
    ).toBe(false);
  });

  it.each([
    [
      "container port",
      (input: HostLocalManagedInferenceInput) => ({ ...input, containerPort: 8001 }),
    ],
    [
      "environment names",
      (input: HostLocalManagedInferenceInput) => ({ ...input, environment: [] }),
    ],
    [
      "shared memory",
      (input: HostLocalManagedInferenceInput) => ({ ...input, sharedMemory: "128m" }),
    ],
    ["IPC mode", (input: HostLocalManagedInferenceInput) => ({ ...input, ipc: "host" as const })],
    [
      "command",
      (input: HostLocalManagedInferenceInput) => ({ ...input, command: ["--model", "other"] }),
    ],
    [
      "mounts",
      (input: HostLocalManagedInferenceInput) => ({
        ...input,
        mounts: [{ source: "/tmp/model", target: "/model", readOnly: true }],
      }),
    ],
  ] as const)("rejects published-resume %s drift before runtime mutation", (_label, mutate) => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const initial = runtime.startManaged(harness.input, harness.writer);
    initial.validateBeforeCommit();
    const receipt = initial.commit();
    harness.events.length = 0;

    expect(() => runtime.resumeManaged?.(mutate(harness.input), receipt, harness.writer)).toThrow();
    expect(harness.container()).toMatchObject({ running: true });
    expect(
      harness.events.some(
        (event) =>
          event.includes(`podman:start ${"a".repeat(64)}`) ||
          event.includes(`podman:stop --time 30 ${"a".repeat(64)}`) ||
          event.includes(`podman:rm --force ${"a".repeat(64)}`),
      ),
    ).toBe(false);
  });

  it("retains a published running runtime when resume proof fails", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const initial = runtime.startManaged(harness.input, harness.writer);
    initial.validateBeforeCommit();
    const receipt = initial.commit();
    harness.state.probeFailure = "inference";
    harness.events.length = 0;

    expect(() => runtime.resumeManaged?.(harness.input, receipt, harness.writer)).toThrow(
      "probe exited 22",
    );
    expect(harness.container()).toMatchObject({ running: true });
    expect(
      harness.events.some((event) => event.includes(`podman:rm --force ${"a".repeat(64)}`)),
    ).toBe(false);
  });

  it.each(["ready", "gpu", "inference"] as const)(
    "restarts only the exact prior-running runtime when it exits during %s proof",
    (phase) => {
      const harness = createPodmanHostLocalInferenceTestHarness();
      const runtime = operationRuntime(harness);
      const initial = runtime.startManaged(harness.input, harness.writer);
      initial.validateBeforeCommit();
      const receipt = initial.commit();
      harness.state.parentExitDuringProof = phase;
      harness.events.length = 0;

      expect(() => runtime.resumeManaged?.(harness.input, receipt, harness.writer)).toThrow();

      expect(harness.container()).toMatchObject({
        id: "a".repeat(64),
        running: true,
        status: "running",
      });
      const parentStarts = harness.events.filter(
        (event) => event === `podman:start ${"a".repeat(64)}`,
      );
      expect(parentStarts).toHaveLength(1);
      expect(
        harness.events.some((event) => event.includes(`podman:rm --force ${"a".repeat(64)}`)),
      ).toBe(false);
      const evidenceIndex = harness.events.indexOf(`evidence:${phase}`);
      const startIndex = harness.events.indexOf(`podman:start ${"a".repeat(64)}`);
      expect(evidenceIndex).toBeGreaterThanOrEqual(0);
      expect(startIndex).toBeGreaterThan(evidenceIndex);
      expect(
        harness.events.some(
          (event, index) =>
            index > evidenceIndex &&
            index < startIndex &&
            event.includes(`podman:rm --force ${"c".repeat(64)}`),
        ),
      ).toBe(phase !== "gpu");
    },
  );

  it("re-proves a lost rollback-start acknowledgement before preserving the original failure", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const initial = runtime.startManaged(harness.input, harness.writer);
    initial.validateBeforeCommit();
    const receipt = initial.commit();
    harness.state.parentExitDuringProof = "gpu";
    harness.state.startLostAcknowledgement = true;
    harness.events.length = 0;

    expect(() => runtime.resumeManaged?.(harness.input, receipt, harness.writer)).toThrow();

    expect(harness.container()).toMatchObject({ running: true, status: "running" });
    const gpuEvidence = harness.events.indexOf("evidence:gpu");
    const exactStart = harness.events.indexOf(`podman:start ${"a".repeat(64)}`);
    const rollbackEvidence = harness.events.indexOf("evidence:rollback");
    expect(gpuEvidence).toBeGreaterThanOrEqual(0);
    expect(exactStart).toBeGreaterThan(gpuEvidence);
    expect(rollbackEvidence).toBeGreaterThan(exactStart);
    expect(
      harness.events.some((event) => event.includes(`podman:rm --force ${"a".repeat(64)}`)),
    ).toBe(false);
  });

  it("fails closed without deletion when exact prior-running restoration cannot be proved", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const initial = runtime.startManaged(harness.input, harness.writer);
    initial.validateBeforeCommit();
    const receipt = initial.commit();
    harness.state.parentExitDuringProof = "gpu";
    harness.state.startLeavesContainerStopped = true;
    harness.events.length = 0;

    expect(() => runtime.resumeManaged?.(harness.input, receipt, harness.writer)).toThrow(
      "Exact prior-runtime restoration also failed",
    );

    expect(harness.container()).toMatchObject({ running: false, status: "exited" });
    expect(
      harness.events.some((event) => event.includes(`podman:rm --force ${"a".repeat(64)}`)),
    ).toBe(false);
  });

  it("restores a published stopped runtime when resume proof fails", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const initial = runtime.startManaged(harness.input, harness.writer);
    initial.validateBeforeCommit();
    const receipt = initial.commit();
    runtime.stopManaged(receipt);
    harness.state.probeFailure = "inference";
    harness.events.length = 0;

    expect(() => runtime.resumeManaged?.(harness.input, receipt, harness.writer)).toThrow(
      "probe exited 22",
    );
    expect(harness.container()).toMatchObject({ running: false, status: "exited" });
    expect(
      harness.events.some((event) => event.includes(`podman:rm --force ${"a".repeat(64)}`)),
    ).toBe(false);
  });

  it.each([
    { priorState: "absent" as const, expectedRunning: null },
    { priorState: "running" as const, expectedRunning: true },
    { priorState: "stopped" as const, expectedRunning: false },
  ])(
    "restores exact $priorState state after a same-transaction recovery failure",
    ({ priorState, expectedRunning }) => {
      const harness = createPodmanHostLocalInferenceTestHarness();
      const { operation, runtime } = operationAndRuntime(harness);
      harness.seedManaged(priorState, true, operation.bindingSha256);
      harness.state.probeFailure = "inference";
      harness.events.length = 0;

      expect(() => runtime.recoverManaged?.(harness.input, harness.writer)).toThrow(
        "probe exited 22",
      );
      expect(harness.container()?.running ?? null).toBe(expectedRunning);
      const evidenceIndex = harness.events.findIndex((event) => event === "evidence:inference");
      const cleanupIndices = harness.events
        .map((event, index) => ({ event, index }))
        .filter(
          ({ event }) =>
            event.includes(`podman:rm --force ${"a".repeat(64)}`) ||
            event.includes(`podman:stop --time 30 ${"a".repeat(64)}`),
        )
        .map(({ index }) => index);
      expect(evidenceIndex).toBeGreaterThanOrEqual(0);
      expect(cleanupIndices.every((index) => index > evidenceIndex)).toBe(true);
    },
  );

  it("rejects a stale transaction label before recovery mutation", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const { operation, runtime } = operationAndRuntime(harness);
    harness.seedManaged("stopped", true, operation.bindingSha256);
    const seeded = harness.container();
    expect(seeded).not.toBeNull();
    Object.assign(seeded?.labels ?? {}, {
      "ai.nvidia.nemoclaw.inference.transaction-sha256": "5".repeat(64),
    });
    harness.events.length = 0;

    expect(() => runtime.recoverManaged?.(harness.input, harness.writer)).toThrow(
      "does not match its exact managed authority",
    );
    expect(harness.container()?.running).toBe(true);
    expect(
      harness.events.some(
        (event) =>
          event.startsWith("podman:start ") ||
          event.startsWith("podman:stop ") ||
          event.startsWith("podman:rm "),
      ),
    ).toBe(false);
  });

  it("retries one lost receipt acknowledgement and then commits exactly", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.writerFailuresRemaining = 1;
    const runtime = operationRuntime(harness);
    const prepared = runtime.startManaged(harness.input, harness.writer);
    prepared.validateBeforeCommit();

    expect(prepared.commit()).toEqual(prepared.receipt);
    expect(harness.written).toHaveLength(1);
    expect(harness.events.filter((event) => event === "receipt:write")).toHaveLength(2);
  });

  it("marks double publication failure indeterminate and forbids destructive rollback", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    harness.state.writerFailuresRemaining = 2;
    const runtime = operationRuntime(harness);
    const prepared = runtime.startManaged(harness.input, harness.writer);
    prepared.validateBeforeCommit();

    expect(() => prepared.commit()).toThrow("remains indeterminate");
    expect(prepared.publicationState()).toBe("indeterminate");
    expect(() => prepared.rollback()).toThrow("terminal state 'indeterminate'");
    expect(harness.container()).not.toBeNull();
    expect(harness.written).toHaveLength(1);
  });

  it("accepts a lost remove acknowledgement only after exact absence proof", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const prepared = runtime.startManaged(harness.input, harness.writer);
    prepared.validateBeforeCommit();
    const receipt = prepared.commit();
    harness.state.removeLostAcknowledgement = true;
    harness.failures.length = 0;

    expect(runtime.destroy(receipt)).toMatchObject({ status: "removed" });
    expect(harness.container()).toBeNull();
    expect(harness.failures).toEqual([
      expect.objectContaining({
        phase: "cleanup",
        message: expect.stringContaining("transport closed after remove"),
      }),
    ]);
  });

  it("captures a lost stop acknowledgement only after exact at-rest proof", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const prepared = runtime.startManaged(harness.input, harness.writer);
    prepared.validateBeforeCommit();
    const receipt = prepared.commit();
    harness.state.stopLostAcknowledgement = true;
    harness.failures.length = 0;
    harness.events.length = 0;

    expect(runtime.stopManaged(receipt)).toMatchObject({ running: false });
    expect(harness.container()).toMatchObject({ running: false, status: "exited" });
    expect(harness.failures).toEqual([
      expect.objectContaining({ phase: "stop", message: expect.stringContaining("after stop") }),
    ]);
  });

  it("rejects a corrupt authority-store record before any runtime mutation", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const operation = createPodmanHostLocalInferenceOperation({
      engine: harness.engine,
      env: harness.env,
      probeCleanupTiming: harness.probeCleanupTiming,
      authorityStore: {
        load: () => null,
        record: (authority) => ({ ...authority, engineId: "docker" }),
      },
      routeAuthorityStore: harness.routeAuthorityStore,
      onFailureEvidence: harness.onFailureEvidence,
      redactSensitive: harness.redactSensitive,
    });
    harness.events.length = 0;
    expect(() => operation.managedRuntime?.startManaged(harness.input, harness.writer)).toThrow(
      "does not match persisted authority",
    );
    expect(
      harness.events.some(
        (event) =>
          event.startsWith("podman:run ") ||
          event.startsWith("podman:start ") ||
          event.startsWith("podman:rm "),
      ),
    ).toBe(false);
    expect(harness.container()).toBeNull();
  });

  it("disables ambient proxy inheritance for workload and provider-owned probes", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const proxySecret = "https://proxy-user:proxy-secret@proxy.invalid";
    harness.env.HTTPS_PROXY = proxySecret;
    const runtime = operationRuntime(harness);
    harness.events.length = 0;

    const prepared = runtime.startManaged(harness.input, harness.writer);
    prepared.validateBeforeCommit();
    prepared.commit();

    const runEvents = harness.events.filter((event) => event.startsWith("podman:run "));
    expect(runEvents.length).toBeGreaterThan(2);
    expect(runEvents.every((event) => event.startsWith("podman:run --http-proxy=false "))).toBe(
      true,
    );
    expect(JSON.stringify(prepared.receipt)).not.toContain(proxySecret);
    expect(harness.events.join("\n")).not.toContain(proxySecret);
    expect(harness.failures.map(({ message }) => message).join("\n")).not.toContain(proxySecret);
  });

  it.each([
    { mode: "residue" as const, message: "left runtime" },
    { mode: "reuse" as const, message: "name 'nemoclaw-nim' reused" },
  ])("fails closed for indeterminate cleanup: $mode", ({ mode, message }) => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const prepared = runtime.startManaged(harness.input, harness.writer);
    prepared.validateBeforeCommit();
    const receipt = prepared.commit();
    harness.state.removeLeavesContainer = mode === "residue";
    harness.state.reuseNameAfterRemoval = mode === "reuse";

    expect(() => runtime.destroy(receipt)).toThrow(message);
  });

  it("fails prepare-destroy closed when the managed name was reused", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const prepared = runtime.startManaged(harness.input, harness.writer);
    prepared.validateBeforeCommit();
    const receipt = prepared.commit();
    harness.state.reuseNameAfterRemoval = true;
    harness.engine.capture(["rm", "--force", "a".repeat(64)]);

    expect(() => runtime.prepareDestroy(receipt)).toThrow("name 'nemoclaw-nim' reused");
  });

  it.each([
    {
      label: "missing observed GPU identity",
      options: { gpuIdentities: [] as readonly string[] },
      message: "exact NVIDIA GPU identities",
    },
    {
      label: "indexed CDI alias",
      options: {
        cdiDevices: ["nvidia.com/gpu=0", "nvidia.com/gpu=1"],
        gpuIdentities: ["GPU-12345678-1234-1234-1234-123456789abc"],
      },
      message: "requires explicit physical NVIDIA GPU UUID",
    },
    {
      label: "all-GPU CDI alias",
      options: {
        cdiDevices: ["nvidia.com/gpu=all"],
      },
      message: "requires explicit physical NVIDIA GPU UUID",
    },
    {
      label: "MIG CDI alias without MIG-native identity proof",
      options: {
        cdiDevices: ["nvidia.com/gpu=MIG-GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/1/0"],
      },
      message: "requires explicit physical NVIDIA GPU UUID",
    },
    {
      label: "UUID CDI identity mismatch",
      options: {
        cdiDevices: ["nvidia.com/gpu=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
        gpuIdentities: ["GPU-12345678-1234-1234-1234-123456789abc"],
      },
      message: "differs from the requested CDI UUID",
    },
  ])("rejects $label and removes the uncommitted runtime", ({ options, message }) => {
    const harness = createPodmanHostLocalInferenceTestHarness(options);
    const runtime = operationRuntime(harness);

    expect(() => runtime.startManaged(harness.input, harness.writer)).toThrow(message);
    expect(harness.container()).toBeNull();
    expect(harness.written).toHaveLength(0);
  });

  it("accepts only an exact multi-GPU UUID set proved inside the managed runtime", () => {
    const gpuA = "GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const gpuB = "GPU-11111111-2222-3333-4444-555555555555";
    const expectedDevices = [`nvidia.com/gpu=${gpuB}`, `nvidia.com/gpu=${gpuA}`].sort();
    const harness = createPodmanHostLocalInferenceTestHarness({
      cdiDevices: expectedDevices,
      gpuIdentities: [gpuA, gpuB],
    });
    const runtime = operationRuntime(harness);

    const prepared = runtime.startManaged(harness.input, harness.writer);
    expect(prepared.receipt.runtime).toMatchObject({
      gpu: { devices: expectedDevices },
    });
    expect(prepared.rollback()).toMatchObject({ status: "removed" });
  });

  it("supports inspect, stop, revalidation, and exact destroy without cross-engine calls", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);
    const prepared = runtime.startManaged(harness.input, harness.writer);
    prepared.validateBeforeCommit();
    const receipt = prepared.commit();

    expect(runtime.inspectManaged(receipt)).toMatchObject({ running: true });
    expect(runtime.stopManaged(receipt)).toMatchObject({ running: false });
    expect(() => runtime.preserveForRebuild(receipt)).toThrow("requires a running runtime");
    harness.engine.capture(["start", "a".repeat(64)]);
    expect(runtime.preserveForRebuild(receipt)).toEqual(receipt);
    expect(runtime.prepareDestroy(receipt)).toEqual(receipt);
    expect(runtime.destroy(receipt)).toMatchObject({ status: "removed" });
    expect(runtime.destroy(receipt)).toMatchObject({ status: "already-absent" });
    expect(harness.events.join("\n")).not.toContain("docker");
  });

  it("rejects secret-bearing commands, all host bind mounts, and absent env values", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    const runtime = operationRuntime(harness);

    expect(() =>
      runtime.startManaged({ ...harness.input, command: ["--api-key=test-value"] }, harness.writer),
    ).toThrow("must not carry credential material");
    expect(() =>
      runtime.startManaged({ ...harness.input, networkName: "host" }, harness.writer),
    ).toThrow("must identify an isolated provider-owned network");
    expect(() => runtime.startManaged({ ...harness.input, ipc: "host" }, harness.writer)).toThrow(
      "requires a private IPC namespace",
    );
    expect(() =>
      runtime.startManaged(
        { ...harness.input, mounts: [{ source: "/srv/models/../secret", target: "/models" }] },
        harness.writer,
      ),
    ).toThrow("rejects host bind mounts until an exact source authority is injected");
    expect(() =>
      runtime.startManaged(
        {
          ...harness.input,
          mounts: [{ source: "/run/user/1000/podman/podman.sock", target: "/run/podman.sock" }],
        },
        harness.writer,
      ),
    ).toThrow("rejects host bind mounts until an exact source authority is injected");

    const missing = createPodmanHostLocalInferenceTestHarness();
    const missingRuntime = createPodmanHostLocalInferenceRuntime({
      engine: missing.engine,
      env: {},
      probeCleanupTiming: missing.probeCleanupTiming,
      authorityStore: missing.authorityStore,
      routeAuthorityStore: missing.routeAuthorityStore,
      authority: qualifyPodmanInferenceAuthority(missing.engine),
      onFailureEvidence: missing.onFailureEvidence,
      redactSensitive: missing.redactSensitive,
    });
    expect(() => missingRuntime.startManaged(missing.input, missing.writer)).toThrow(
      "requires environment 'NGC_API_KEY'",
    );
    expect(missing.container()).toBeNull();
    const vllm = createPodmanHostLocalInferenceTestHarness({ service: "vllm" });
    const vllmRuntime = operationRuntime(vllm);
    expect(() =>
      vllmRuntime.startManaged({ ...vllm.input, environment: ["VLLM_API_KEY"] }, vllm.writer),
    ).toThrow("unauthenticated and rejects VLLM_API_KEY");
    expect(vllm.container()).toBeNull();
  });

  it("requires a qualified injected redactor before any provider call", () => {
    const harness = createPodmanHostLocalInferenceTestHarness();
    expect(() =>
      createPodmanHostLocalInferenceOperation({
        engine: harness.engine,
        env: harness.env,
        probeCleanupTiming: harness.probeCleanupTiming,
        authorityStore: harness.authorityStore,
        routeAuthorityStore: harness.routeAuthorityStore,
        onFailureEvidence: harness.onFailureEvidence,
        redactSensitive: (value) => value,
      }),
    ).toThrow("redactor failed qualification");
    expect(harness.events).toHaveLength(0);
  });
});
