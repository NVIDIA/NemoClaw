// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createPodmanHostLocalInferenceTestHarness,
  throwAfterPodmanEvent,
} from "../../../../test/helpers/podman-host-local-inference-test-harness";
import {
  type HostLocalManagedInferenceInput,
  normalizeHostLocalInferenceReceipt,
} from "./host-local-inference";
import { PORTABLE_HOST_GATEWAY_IP } from "../experimental/portable-profile";
import { prepareHostLocalInferenceStartup } from "./host-local-inference-routing";
import { createPodmanHostLocalInferenceOperation } from "./podman-host-local-inference";

const OLLAMA_MODEL_SIZE = 8 * 1024 ** 3;
const OLLAMA_MODEL_DIGEST = "7".repeat(64);

function managedOllamaFixture(
  options: {
    readonly externalNetwork?: boolean;
    readonly externalListenerIp?: string;
    readonly inputListenerIp?: string;
  } = {},
) {
  const harness = createPodmanHostLocalInferenceTestHarness();
  const assertCurrent = vi.fn();
  const externalListenerIp = options.externalListenerIp ?? PORTABLE_HOST_GATEWAY_IP;
  const inputListenerIp = options.inputListenerIp ?? externalListenerIp;
  const operation = createPodmanHostLocalInferenceOperation({
    engine: harness.engine,
    env: harness.env,
    acceleration: harness.operationAcceleration,
    authorityStore: harness.authorityStore,
    routeAuthorityStore: harness.routeAuthorityStore,
    ...(options.externalNetwork === false
      ? {}
      : {
          externalNetwork: {
            networkId: harness.input.networkId,
            name: harness.input.networkName,
            subnet: "10.89.0.0/24",
            gatewayIp: harness.input.networkGatewayIp,
            listenerIp: externalListenerIp,
            authoritySha256: "8".repeat(64),
            assertCurrent,
          },
        }),
    onFailureEvidence: harness.onFailureEvidence,
    redactSensitive: harness.redactSensitive,
  });
  const input = {
    ...harness.input,
    service: "ollama" as const,
    containerName: "nemoclaw-hermes-ollama",
    containerPort: 11434,
    imageRef: `docker.io/ollama/ollama@sha256:${"1".repeat(64)}`,
    environment: [],
    ollamaContextLength: 64_000,
    model: "qwen3-vl:4b",
    networkListenerIp: inputListenerIp,
    hostPort: 11434,
  } as HostLocalManagedInferenceInput;
  harness.state.ollamaPsModels = [
    {
      name: input.model,
      model: input.model,
      size: OLLAMA_MODEL_SIZE,
      size_vram: OLLAMA_MODEL_SIZE,
      digest: OLLAMA_MODEL_DIGEST,
    },
  ];
  return { assertCurrent, harness, input, operation };
}

function prepareManagedOllama(
  fixture: ReturnType<typeof managedOllamaFixture>,
  input: HostLocalManagedInferenceInput = fixture.input,
) {
  return prepareHostLocalInferenceStartup(fixture.operation, {
    application: "hermes",
    service: "ollama",
    managed: input,
    receiptWriter: fixture.harness.writer,
  });
}

describe("Podman managed Ollama lifecycle", () => {
  it.each([
    ["wildcard", "0.0.0.0"],
    ["alternate", PORTABLE_HOST_GATEWAY_IP],
  ])("rejects a %s listener without external network authority (#9596)", (_name, listenerIp) => {
    const fixture = managedOllamaFixture({ externalNetwork: false, inputListenerIp: listenerIp });

    expect(() => prepareManagedOllama(fixture)).toThrow(
      "listener requires exact external network authority",
    );
    expect(fixture.harness.events.some((event) => event.startsWith("podman:run "))).toBe(false);
  });

  it.each([
    ["wildcard", "0.0.0.0"],
    ["network", "10.89.0.0"],
    ["broadcast", "10.89.0.255"],
    ["gateway", "10.89.0.1"],
    ["inside-subnet alternate", "10.89.0.2"],
    ["multicast", "224.0.0.1"],
    ["reserved", "240.0.0.1"],
  ])("rejects a %s external listener before Podman run (#9596)", (_name, listenerIp) => {
    const fixture = managedOllamaFixture({
      externalListenerIp: listenerIp,
      inputListenerIp: listenerIp,
    });

    expect(() => prepareManagedOllama(fixture)).toThrow("exact unicast host address");
    expect(fixture.harness.events.some((event) => event.startsWith("podman:run "))).toBe(false);
  });

  it("rejects a loopback external listener before Podman run (#9596)", () => {
    const fixture = managedOllamaFixture({
      externalListenerIp: "127.0.0.1",
      inputListenerIp: "127.0.0.1",
    });

    expect(() => prepareManagedOllama(fixture)).toThrow("exact non-loopback IPv4 address");
    expect(fixture.harness.events.some((event) => event.startsWith("podman:run "))).toBe(false);
  });

  it("rejects listener drift from external network authority before Podman run (#9596)", () => {
    const fixture = managedOllamaFixture({
      externalListenerIp: PORTABLE_HOST_GATEWAY_IP,
      inputListenerIp: "192.0.2.2",
    });

    expect(() => prepareManagedOllama(fixture)).toThrow(
      "network listener changed after qualification",
    );
    expect(fixture.harness.events.some((event) => event.startsWith("podman:run "))).toBe(false);
  });

  it("reports model acquisition failure before trailing authority drift (#9596)", () => {
    const fixture = managedOllamaFixture();
    fixture.harness.state.ollamaPullFailure = "model pull failed";
    fixture.assertCurrent.mockImplementation(() =>
      throwAfterPodmanEvent(fixture.harness.events, "ollama pull", "trailing authority drift"),
    );

    expect(() => prepareManagedOllama(fixture)).toThrow("managed Ollama model acquisition");
  });

  it.each([63_999, 64_001])(
    "rejects unsupported managed Ollama context length %i before Podman run (#9211)",
    (ollamaContextLength) => {
      const fixture = managedOllamaFixture();

      expect(() =>
        prepareManagedOllama(fixture, { ...fixture.input, ollamaContextLength }),
      ).toThrow(
        "Podman managed Ollama context length is invalid",
      );
      expect(fixture.harness.events.some((event) => event.startsWith("podman:run "))).toBe(false);
    },
  );

  it("creates and rolls back a receipt-owned runtime for fresh Portable Hermes (#9596)", () => {
    const fixture = managedOllamaFixture();
    const { assertCurrent, harness, input } = fixture;
    const route = prepareManagedOllama(fixture);
    const prepared = route.prepared;

    expect(route.applicationBaseUrl).toBe("https://inference.local/v1");
    expect(route.gatewayProviderBaseUrl).toBe("http://host.openshell.internal:11434/v1");
    expect(prepared.receipt).toMatchObject({
      providerId: "podman",
      service: "ollama",
      endpoint: {
        networkId: harness.input.networkId,
        networkName: harness.input.networkName,
        networkGatewayIp: harness.input.networkGatewayIp,
        networkListenerIp: PORTABLE_HOST_GATEWAY_IP,
        networkAuthoritySha256: "8".repeat(64),
      },
      inference: { model: "qwen3-vl:4b" },
      runtime: {
        kind: "container",
        runtimeId: "a".repeat(64),
        name: "nemoclaw-hermes-ollama",
        imageRef: input.imageRef,
      },
    });
    expect(() =>
      normalizeHostLocalInferenceReceipt({
        ...prepared.receipt,
        runtime: { ...prepared.receipt.runtime, modelDigest: undefined },
      }),
    ).toThrow("Ollama model digest is malformed");
    expect(assertCurrent).toHaveBeenCalled();
    expect(harness.events).toContainEqual(
      expect.stringContaining(`--publish ${PORTABLE_HOST_GATEWAY_IP}:11434:11434`),
    );
    expect(harness.events).toContainEqual(
      expect.stringContaining("--env OLLAMA_CONTEXT_LENGTH"),
    );
    expect(harness.state.capturedEnvironmentValues).toContainEqual({
      OLLAMA_CONTEXT_LENGTH: "64000",
    });
    const ready = harness.events.findIndex((event) => event.includes("/api/tags"));
    const pull = harness.events.findIndex((event) => event.includes("ollama pull qwen3-vl:4b"));
    const inference = harness.events.findIndex((event) => event.includes("/v1/chat/completions"));
    const placement = harness.events.findIndex((event) => event.includes("/api/ps"));
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(pull).toBeGreaterThan(ready);
    expect(inference).toBeGreaterThan(pull);
    expect(placement).toBeGreaterThan(inference);
    expect(prepared.rollback()).toMatchObject({ status: "removed", priorState: "absent" });
    expect(harness.container()).toBeNull();
    expect(harness.written).toHaveLength(0);
  });
});
