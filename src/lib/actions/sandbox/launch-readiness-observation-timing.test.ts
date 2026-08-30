// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { loadAgent } from "../../agent/defs";
import type {
  LaunchReadinessFence,
  LaunchReadinessIdentity,
  LaunchReadinessLease,
} from "../../state/launch-readiness-lease";
import type { SandboxEntry } from "../../state/registry";
import {
  inspectLaunchReadiness,
  type LaunchReadinessDeps,
  publicationFromDecision,
  publishLaunchReadiness,
} from "./launch-readiness";

const SANDBOX = "alpha";
const GATEWAY = "nemoclaw";
const PORT = 8080;
const EPOCH = "a".repeat(64);
const FINGERPRINT = "b".repeat(64);
const POLICY = `version: 1
network_policies:
  inference:
    name: Inference
    endpoints:
      - host: inference.local
        port: 443
    binaries:
      - path: /usr/bin/curl
`;

function entry(): SandboxEntry {
  return {
    name: SANDBOX,
    openshellDriver: "docker",
    openshellVersion: "0.0.106",
    gatewayName: GATEWAY,
    gatewayPort: PORT,
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: FINGERPRINT,
    agent: "hermes",
    agentVersion: "0.19.0",
    nemoclawVersion: "0.1.0",
    imageTag: "example@sha256:immutable",
    provider: "compatible-endpoint",
    model: "model-a",
    endpointUrl: "https://inference.example.com/v1/chat/completions",
    credentialEnv: "COMPATIBLE_API_KEY",
    preferredInferenceApi: "chat-completions",
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
  };
}

function fence(): LaunchReadinessFence {
  return {
    schemaVersion: 3,
    kind: "fence",
    epochId: EPOCH,
    sandboxName: SANDBOX,
    fencedWallMs: 1,
    fencedUptimeMs: 1,
    bootId: "boot-a",
    uid: 1,
    homeDevice: "1",
    homeInode: "2",
    storeDevice: "1",
    storeInode: "3",
    gatewayName: GATEWAY,
    gatewayPort: PORT,
    publicationState: "ready",
    preservedLeaseStartedWallMs: null,
    preservedLeaseExpiresWallMs: null,
    preservedLeaseElapsedMs: null,
  };
}

function lease(identity: LaunchReadinessIdentity): LaunchReadinessLease {
  return {
    schemaVersion: 3,
    kind: "lease",
    epochId: EPOCH,
    sandboxName: SANDBOX,
    leaseStartedWallMs: 1,
    leaseExpiresWallMs: 86_400_001,
    elapsedAtPublicationMs: 0,
    publishedWallMs: 1,
    publishedUptimeMs: 1,
    bootId: "boot-a",
    uid: 1,
    homeDevice: "1",
    homeInode: "2",
    storeDevice: "1",
    storeInode: "3",
    gatewayName: GATEWAY,
    gatewayPort: PORT,
    identity,
  };
}

describe("launch readiness observation timing", () => {
  it("records every fixed OpenShell-backed semantic observation without its values", async () => {
    const sandbox = entry();
    const stages: string[] = [];
    const failures: string[] = [];
    let inferenceHealthy = true;
    let publishedIdentity: LaunchReadinessIdentity | null = null;
    const deps: LaunchReadinessDeps = {
      getSandbox: () => sandbox,
      listAgents: () => ["hermes"],
      loadAgent,
      observeSandbox: () => ({ state: "ready", liveIdentityFingerprint: FINGERPRINT }),
      capture: (args) => {
        const output =
          args[0] === "policy"
            ? POLICY
            : "Gateway Inference:\n\n  Provider: compatible-endpoint\n  Model: model-a\n";
        return { status: 0, output, stdout: output, stderr: "" } as ReturnType<
          NonNullable<LaunchReadinessDeps["capture"]>
        >;
      },
      gatewayHealth: async () => true,
      forwardsHealthy: () => true,
      inferenceProbe: () => ({
        healthy: inferenceHealthy,
        broken: false,
        httpStatus: inferenceHealthy ? 200 : 503,
        detail: inferenceHealthy ? "OK 200" : "ERROR 503",
      }),
      classifyPortableLifecycleReceipt: () => ({ kind: "absent" }),
      readLease: () =>
        publishedIdentity
          ? { kind: "valid", lease: lease(publishedIdentity) }
          : { kind: "missing" },
      fenceLease: () => fence(),
      publishLease: (_name, _gateway, _port, _epoch, identity) => {
        publishedIdentity = identity;
        return lease(identity);
      },
      withSandboxLock: async (_name, operation) => operation(),
      withGatewayLock: async (_name, operation) => operation(),
      recordObservationTiming: (stage, elapsedMs) => {
        expect(elapsedMs).toBeGreaterThanOrEqual(0);
        stages.push(stage);
      },
      recordObservationFailure: (stage) => failures.push(stage),
    };

    const initial = await inspectLaunchReadiness(SANDBOX, deps);
    expect(initial).toMatchObject({ kind: "fallback", category: "missing" });
    await expect(
      publishLaunchReadiness(publicationFromDecision(SANDBOX, initial), deps),
    ).resolves.toEqual({ kind: "published" });
    stages.length = 0;

    await expect(inspectLaunchReadiness(SANDBOX, deps)).resolves.toMatchObject({
      kind: "accepted",
    });
    expect(stages).toEqual([
      "sandbox-identity",
      "policy-get",
      "inference-get",
      "gateway-health",
      "forward-health",
      "inference-route",
    ]);
    expect(failures).toEqual([]);

    stages.length = 0;
    inferenceHealthy = false;
    await expect(inspectLaunchReadiness(SANDBOX, deps)).resolves.toMatchObject({
      kind: "fallback",
      category: "health",
    });
    expect(stages.at(-1)).toBe("inference-route");
    expect(failures).toEqual(["inference-route"]);
  });
});
