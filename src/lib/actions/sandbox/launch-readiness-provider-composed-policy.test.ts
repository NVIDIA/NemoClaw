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

function deps(policy: string): LaunchReadinessDeps {
  const outputs: Readonly<Record<string, string>> = Object.freeze({
    policy,
    inference: "Gateway Inference:\n\n  Provider: compatible-endpoint\n  Model: model-a\n",
  });
  return {
    getSandbox: entry,
    listAgents: () => ["hermes"],
    loadAgent,
    observeSandbox: () => ({ state: "ready", liveIdentityFingerprint: FINGERPRINT }),
    capture: (args) => {
      const output = outputs[String(args[0])] ?? "";
      return { status: 0, output, stdout: output, stderr: "" } as ReturnType<
        NonNullable<LaunchReadinessDeps["capture"]>
      >;
    },
    gatewayHealth: async () => true,
    forwardsHealthy: () => true,
    inferenceProbe: async () => ({
      healthy: true,
      broken: false,
      httpStatus: 200,
      detail: "OK 200",
    }),
    classifyPortableLifecycleReceipt: () => ({ kind: "absent" }),
    readLease: () => ({ kind: "missing" }),
    fenceLease: fence,
    publishLease: (_name, _gateway, _port, _epoch, identity) => lease(identity),
    withSandboxLock: async (_name, operation) => operation(),
    withGatewayLock: async (_name, operation) => operation(),
  };
}

async function publishWithFinalPolicy(policy: string) {
  const publication = publicationFromDecision(
    SANDBOX,
    await inspectLaunchReadiness(SANDBOX, deps(POLICY)),
  );
  return publishLaunchReadiness(publication, deps(policy));
}

describe("launch readiness provider-composed policy entries", () => {
  it("ignores a name-only MCP provider entry during final policy validation", async () => {
    const policy = `${POLICY}  _provider_alpha_mcp_deepwiki:
    name: _provider_alpha_mcp_deepwiki
`;

    expect(await publishWithFinalPolicy(policy)).toEqual({ kind: "published" });
  });

  it("rejects an incomplete policy entry that OpenShell did not compose", async () => {
    const policy = `${POLICY}  mcp_deepwiki:
    name: mcp_deepwiki
`;

    expect(await publishWithFinalPolicy(policy)).toEqual({
      kind: "policy-observation-failed",
      error: {
        kind: "schema",
        message: "OpenShell returned an invalid sandbox policy document.",
      },
    });
  });
});
