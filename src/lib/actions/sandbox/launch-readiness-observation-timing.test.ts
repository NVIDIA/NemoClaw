// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../agent/defs";
import type {
  LaunchReadinessFence,
  LaunchReadinessIdentity,
  LaunchReadinessLease,
} from "../../state/launch-readiness-lease";
import {
  readLaunchReadinessLease,
  type LaunchReadinessStoreOptions,
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

function publicationDeps(
  assertPublicationCurrent: () => void,
  publishLease: NonNullable<LaunchReadinessDeps["publishLease"]>,
): LaunchReadinessDeps {
  const outputs: Readonly<Record<string, string>> = Object.freeze({
    policy: POLICY,
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
    inferenceProbe: () => ({ healthy: true, broken: false, httpStatus: 200, detail: "OK 200" }),
    classifyPortableLifecycleReceipt: () => ({ kind: "absent" }),
    readLease: () => ({ kind: "missing" }),
    fenceLease: fence,
    publishLease,
    withSandboxLock: async (_name, operation) => operation(),
    withGatewayLock: async (_name, operation) => operation(),
    assertPublicationCurrent,
  };
}

describe("launch readiness observation timing", () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks retained authority around final capture and lease publication", async () => {
    const assertPublicationCurrent = vi.fn();
    const publishLease = vi.fn((_name, _gateway, _port, _epoch, identity, _options, commit) => {
      expect(assertPublicationCurrent).toHaveBeenCalledTimes(3);
      commit?.();
      return lease(identity);
    });
    const currentDeps = publicationDeps(assertPublicationCurrent, publishLease);
    const decision = await inspectLaunchReadiness(SANDBOX, currentDeps);

    await expect(
      publishLaunchReadiness(publicationFromDecision(SANDBOX, decision), currentDeps),
    ).resolves.toEqual({ kind: "published" });

    expect(assertPublicationCurrent).toHaveBeenCalledTimes(4);
    expect(publishLease).toHaveBeenCalledOnce();
  });

  it.each([
    ["before semantic capture", 1, 0],
    ["after semantic capture", 2, 0],
    ["before lease storage", 3, 0],
    ["at the lease commit seam", 4, 1],
  ] as const)(
    "fails closed when retained authority changes %s",
    async (_label, failureCall, expectedPublicationAttempts) => {
      const assertPublicationCurrent = vi.fn(() => {
        expect(assertPublicationCurrent.mock.calls.length).not.toBe(failureCall);
      });
      let committed = false;
      const publishLease = vi.fn((_name, _gateway, _port, _epoch, identity, _options, commit) => {
        commit?.();
        committed = true;
        return lease(identity);
      });
      const currentDeps = publicationDeps(assertPublicationCurrent, publishLease);
      const decision = await inspectLaunchReadiness(SANDBOX, currentDeps);

      await expect(
        publishLaunchReadiness(publicationFromDecision(SANDBOX, decision), currentDeps),
      ).resolves.toEqual({ kind: "evidence-failed" });

      expect(publishLease).toHaveBeenCalledTimes(expectedPublicationAttempts);
      expect(committed).toBe(false);
    },
  );

  it("leaves no valid lease when retained authority changes at the real store commit seam", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-publication-currentness-"));
    temporaryRoots.push(root);
    const home = path.join(root, "home");
    const runtimeRoot = path.join(root, "runtime");
    fs.mkdirSync(home, { mode: 0o700 });
    fs.mkdirSync(runtimeRoot, { mode: 0o700 });
    const storeOptions: LaunchReadinessStoreOptions = {
      home,
      nowWallMs: () => 2_000_000_000_000,
      nowUptimeMs: () => 100_000,
      bootId: () => "boot-a",
      uid: () => process.getuid?.() ?? 0,
      randomEpoch: () => EPOCH,
      runtimeAuthorityRoot: () => runtimeRoot,
    };
    const assertPublicationCurrent = vi.fn(() => {
      expect(assertPublicationCurrent.mock.calls.length).not.toBe(4);
    });
    const currentDeps = publicationDeps(assertPublicationCurrent, () => lease({} as never));
    delete currentDeps.readLease;
    delete currentDeps.fenceLease;
    delete currentDeps.publishLease;
    currentDeps.storeOptions = storeOptions;
    const decision = await inspectLaunchReadiness(SANDBOX, currentDeps);

    await expect(
      publishLaunchReadiness(publicationFromDecision(SANDBOX, decision), currentDeps),
    ).resolves.toEqual({ kind: "evidence-failed" });

    expect(readLaunchReadinessLease(SANDBOX, GATEWAY, PORT, storeOptions)).toEqual({
      kind: "missing",
    });
    await expect(inspectLaunchReadiness(SANDBOX, currentDeps)).resolves.toMatchObject({
      kind: "fallback",
      category: "missing",
    });
  });

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
