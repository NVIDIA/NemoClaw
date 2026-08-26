// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  serializedHostLocalInferenceReceipt,
  serializedLlamaCppHostLocalInferenceReceipt,
} from "../helpers/host-local-inference-receipt";
import { createSandboxHostLocalInferenceProvenance } from "../../src/lib/state/registry/host-local-inference";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-local-registry-test-"));
process.env.HOME = tmpDir;

const registry = await import("../../src/lib/state/registry");
const regFile = path.join(tmpDir, ".nemoclaw", "sandboxes.json");
const CREATE_SESSION_ID = "host-local-registry-fixture";
const LIFECYCLE_GENERATION = "123e4567-e89b-42d3-a456-426614174983";
const SANDBOX_IDENTITY_FINGERPRINT = "a".repeat(64);

function prepareVerifiedCreate(
  name: string,
  route: {
    provider: string;
    model: string;
    endpointUrl: string | null;
    endpointSource: "inference-set";
    credentialEnv: string | null;
    preferredInferenceApi: string | null;
    gatewayName: string;
    gatewayPort: number;
  },
) {
  registry.reserveSandboxInferenceRoute(name, {
    ...route,
    reservationSessionId: CREATE_SESSION_ID,
  });
  const authority = {
    sandboxName: name,
    gatewayName: route.gatewayName,
    sessionId: CREATE_SESSION_ID,
    selection: {
      provider: route.provider,
      model: route.model,
      endpointUrl: route.endpointUrl,
      endpointSource: route.endpointSource,
      credentialEnv: route.credentialEnv,
      preferredInferenceApi: route.preferredInferenceApi,
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      nimContainer: null,
    },
  };
  const reservation = registry.qualifyPendingSandboxCreateReservation(
    authority,
    registry.getSandbox(name),
  );
  const policyCreationReceipt = {
    schemaVersion: 1 as const,
    origin: "sandbox-create" as const,
    gatewayName: route.gatewayName,
    gatewayPort: route.gatewayPort,
    sandboxName: name,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    sandboxIdentityFingerprint: SANDBOX_IDENTITY_FINGERPRINT,
    policyHash: "sha256:host-local-fixture",
    policyVersion: 1,
  };
  const checkpoint = {
    schemaVersion: 1 as const,
    state: "verified-create" as const,
    policyAuthority: "nemoclaw-managed" as const,
    observedPolicyAuthority: "owner-unknown" as const,
    gatewayName: route.gatewayName,
    gatewayPort: route.gatewayPort,
    sandboxName: name,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    sandboxIdentityFingerprint: SANDBOX_IDENTITY_FINGERPRINT,
    route: "none" as const,
    policyHash: policyCreationReceipt.policyHash,
    policyVersion: policyCreationReceipt.policyVersion,
    policyCreationReceipt,
  };
  registry.recordPendingSandboxPolicyVerification(reservation, checkpoint);
  return {
    checkpoint,
    registration: {
      lifecycleGeneration: LIFECYCLE_GENERATION,
      lifecycleLiveIdentityFingerprint: SANDBOX_IDENTITY_FINGERPRINT,
      policyAuthority: "nemoclaw-managed" as const,
      policyCreationReceipt,
    },
    reservation,
  };
}

beforeEach(() => {
  fs.rmSync(regFile, { force: true });
});

describe("registry host-local inference authority", () => {
  it("round-trips a canonical receipt without rewriting it", () => {
    const receipt = serializedHostLocalInferenceReceipt();
    registry.registerSandbox({
      name: "host-local",
      hostLocalInferenceReceipt: receipt,
    });

    expect(registry.getSandbox("host-local")?.hostLocalInferenceReceipt).toBe(receipt);
    const data = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(data.sandboxes["host-local"].hostLocalInferenceReceipt).toBe(receipt);
  });

  it("rejects malformed receipt transports on load and save", () => {
    fs.mkdirSync(path.dirname(regFile), { recursive: true });
    fs.writeFileSync(
      regFile,
      JSON.stringify({
        defaultSandbox: "alpha",
        sandboxes: {
          alpha: { name: "alpha", hostLocalInferenceReceipt: '{"providerId": "mxc"}\n' },
        },
      }),
    );
    expect(() => registry.getSandbox("alpha")).toThrow(/invalid host-local inference receipt/);

    fs.rmSync(regFile, { force: true });
    expect(() =>
      registry.save({
        defaultSandbox: "alpha",
        sandboxes: {
          alpha: { name: "alpha", hostLocalInferenceReceipt: "not-json\n" },
        },
      }),
    ).toThrow(/invalid host-local inference receipt/);
    expect(fs.existsSync(regFile)).toBe(false);
  });

  it("round-trips explicit llama.cpp lifecycle provenance only through its exact reservation", () => {
    const receipt = serializedLlamaCppHostLocalInferenceReceipt();
    const provenance = createSandboxHostLocalInferenceProvenance("llama-owner", receipt);
    const route = {
      provider: "llama-cpp-local",
      model: "nemotron-llama-cpp",
      endpointUrl: "https://inference.local/v1",
      endpointSource: "inference-set" as const,
      credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
      preferredInferenceApi: "openai-completions",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      openshellDriver: "docker",
      hostLocalInferenceReceipt: receipt,
      hostLocalInferenceProvenance: provenance,
    } as const;
    const verified = prepareVerifiedCreate("llama-clone", route);
    registry.registerSandbox(
      {
        name: "llama-clone",
        ...route,
        ...verified.registration,
      },
      verified.reservation,
      { verifiedCreate: verified },
    );

    expect(registry.getSandbox("llama-clone")).toMatchObject({
      hostLocalInferenceReceipt: receipt,
      hostLocalInferenceProvenance: provenance,
    });
  });

  it.each([
    ["runtime provider", { openshellDriver: "mxc" }],
    ["route provider", { provider: "vllm-local" }],
    ["model", { model: "different-model" }],
    ["endpoint", { endpointUrl: "https://inference.local/v1/" }],
    ["endpoint source", { endpointSource: "onboard" }],
    ["credential", { credentialEnv: "DIFFERENT_TOKEN" }],
    ["inference API", { preferredInferenceApi: "openai-responses" }],
    ["gateway", { gatewayName: "nemoclaw-8090" }],
    ["gateway port", { gatewayPort: 8090 }],
  ] as const)("rejects %s drift at explicit llama.cpp registration CAS", (label, drift) => {
    const receipt = serializedLlamaCppHostLocalInferenceReceipt();
    const provenance = createSandboxHostLocalInferenceProvenance("llama-owner", receipt);
    const route = {
      provider: "llama-cpp-local",
      model: "nemotron-llama-cpp",
      endpointUrl: "https://inference.local/v1",
      endpointSource: "inference-set" as const,
      credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
      preferredInferenceApi: "openai-completions",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      openshellDriver: "docker",
      hostLocalInferenceReceipt: receipt,
      hostLocalInferenceProvenance: provenance,
    };
    const verified = prepareVerifiedCreate("llama-drift", route);

    expect(() =>
      registry.registerSandbox(
        {
          name: "llama-drift",
          ...route,
          ...verified.registration,
          ...drift,
        },
        verified.reservation,
        { verifiedCreate: verified },
      ),
    ).toThrow(
      label === "gateway port" ? /policy creation receipt does not match/u : /reservation changed/u,
    );
  });

  it("rejects receipt or original-owner drift at explicit llama.cpp registration CAS", () => {
    const receipt = serializedLlamaCppHostLocalInferenceReceipt();
    const provenance = createSandboxHostLocalInferenceProvenance("llama-owner", receipt);
    const route = {
      provider: "llama-cpp-local",
      model: "nemotron-llama-cpp",
      endpointUrl: "https://inference.local/v1",
      endpointSource: "inference-set" as const,
      credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
      preferredInferenceApi: "openai-completions",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      openshellDriver: "docker",
      hostLocalInferenceReceipt: receipt,
      hostLocalInferenceProvenance: provenance,
    };
    const ownerVerified = prepareVerifiedCreate("llama-owner-drift", route);
    expect(() =>
      registry.registerSandbox(
        {
          name: "llama-owner-drift",
          ...route,
          ...ownerVerified.registration,
          hostLocalInferenceProvenance: createSandboxHostLocalInferenceProvenance(
            "different-owner",
            receipt,
          ),
        },
        ownerVerified.reservation,
        { verifiedCreate: ownerVerified },
      ),
    ).toThrow(/reservation changed/);

    fs.rmSync(regFile, { force: true });
    const receiptVerified = prepareVerifiedCreate("llama-receipt-drift", route);
    const changedReceipt = serializedLlamaCppHostLocalInferenceReceipt("mxc");
    expect(() =>
      registry.registerSandbox(
        {
          name: "llama-receipt-drift",
          ...route,
          ...receiptVerified.registration,
          hostLocalInferenceReceipt: changedReceipt,
          hostLocalInferenceProvenance: createSandboxHostLocalInferenceProvenance(
            "llama-owner",
            changedReceipt,
          ),
        },
        receiptVerified.reservation,
        { verifiedCreate: receiptVerified },
      ),
    ).toThrow(/reservation changed/);
  });

  it("keeps an explicit llama.cpp reservation immutable across repeated route writes", () => {
    const receipt = serializedLlamaCppHostLocalInferenceReceipt();
    const provenance = createSandboxHostLocalInferenceProvenance("llama-owner", receipt);
    const route = {
      provider: "llama-cpp-local",
      model: "nemotron-llama-cpp",
      endpointUrl: "https://inference.local/v1",
      endpointSource: "inference-set" as const,
      credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
      preferredInferenceApi: "openai-completions",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      openshellDriver: "docker",
      hostLocalInferenceReceipt: receipt,
      hostLocalInferenceProvenance: provenance,
    };
    registry.reserveSandboxInferenceRoute("llama-stable", route);
    expect(registry.reserveSandboxInferenceRoute("llama-stable", route)).toBe(true);

    expect(() =>
      registry.reserveSandboxInferenceRoute("llama-stable", {
        ...route,
        model: "different-model",
      }),
    ).toThrow(/Cannot change an explicit host-local inference lifecycle reservation/);
    const { hostLocalInferenceProvenance: _provenance, ...unmarkedRoute } = route;
    expect(() => registry.reserveSandboxInferenceRoute("llama-stable", unmarkedRoute)).toThrow(
      /Cannot change an explicit host-local inference lifecycle reservation/,
    );
    expect(registry.updateSandbox("llama-stable", { model: "different-model" })).toBe(false);
    expect(
      registry.updateSandbox("llama-stable", {
        hostLocalInferenceProvenance: undefined,
      }),
    ).toBe(false);
    expect(registry.updateSandbox("llama-stable", { policies: ["baseline"] })).toBe(true);
    expect(registry.getSandbox("llama-stable")).toMatchObject(route);
  });

  it("admits provenance creation through reservation rather than a generic row update", () => {
    const receipt = serializedLlamaCppHostLocalInferenceReceipt();
    registry.registerSandbox({
      name: "legacy-llama",
      hostLocalInferenceReceipt: receipt,
    });

    expect(
      registry.updateSandbox("legacy-llama", {
        hostLocalInferenceProvenance: createSandboxHostLocalInferenceProvenance(
          "legacy-llama",
          receipt,
        ),
      }),
    ).toBe(false);
    expect(registry.getSandbox("legacy-llama")?.hostLocalInferenceProvenance).toBeUndefined();
  });

  it("rejects provenance whose receipt bytes changed", () => {
    const receipt = serializedLlamaCppHostLocalInferenceReceipt();
    const provenance = createSandboxHostLocalInferenceProvenance("llama-owner", receipt);
    expect(() =>
      registry.reserveSandboxInferenceRoute("drifted", {
        provider: "vllm-local",
        model: "model-a",
        endpointUrl: "https://inference.local/v1",
        endpointSource: "inference-set",
        credentialEnv: null,
        preferredInferenceApi: "openai-completions",
        gatewayName: "nemoclaw",
        hostLocalInferenceReceipt: serializedHostLocalInferenceReceipt(),
        hostLocalInferenceProvenance: provenance,
      }),
    ).toThrow(/provenance does not match its receipt/);
  });
});
