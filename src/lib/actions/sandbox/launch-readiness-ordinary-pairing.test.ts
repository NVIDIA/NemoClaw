// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../agent/defs";
import type { SandboxEntry } from "../../state/registry";
import {
  buildLaunchReadinessRegistryProjection,
  type LaunchReadinessDeps,
  launchReadinessDigest,
  resolveOrdinaryOpenClawPairingTarget,
} from "./launch-readiness";

const SANDBOX_NAME = "alpha";
const GATEWAY_NAME = "nemoclaw";
const FINGERPRINT = "b".repeat(64);

function openClawEntry(): SandboxEntry {
  return {
    name: SANDBOX_NAME,
    openshellDriver: "docker",
    openshellVersion: "0.0.99",
    gatewayName: GATEWAY_NAME,
    gatewayPort: 8080,
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: FINGERPRINT,
    agent: null,
    agentVersion: "1.0.0",
    nemoclawVersion: "2.0.0",
    imageTag: "example@sha256:immutable",
    provider: null,
    model: null,
    endpointUrl: null,
    credentialEnv: null,
    preferredInferenceApi: null,
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
  };
}

describe("ordinary OpenClaw pairing target", () => {
  const deps: LaunchReadinessDeps = {
    getSandbox: vi.fn(),
    listAgents: vi.fn(() => ["openclaw"]),
    loadAgent: vi.fn(() => loadAgent("openclaw")),
  };

  it("resolves the finalized default OpenClaw runtime identity (#9844)", () => {
    vi.mocked(deps.getSandbox!).mockReturnValue(openClawEntry());

    expect(resolveOrdinaryOpenClawPairingTarget(SANDBOX_NAME, deps)).toEqual({
      gatewayName: GATEWAY_NAME,
      openshellDriver: "docker",
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: FINGERPRINT,
      stateDirectory: "/sandbox/.openclaw",
      version: "1.0.0",
    });
  });

  it("resolves ordinary pairing after a supported policy-skip onboarding (#9817)", () => {
    vi.mocked(deps.getSandbox!).mockReturnValue({
      ...openClawEntry(),
    });

    expect(resolveOrdinaryOpenClawPairingTarget(SANDBOX_NAME, deps)).toEqual({
      gatewayName: GATEWAY_NAME,
      openshellDriver: "docker",
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: FINGERPRINT,
      stateDirectory: "/sandbox/.openclaw",
      version: "1.0.0",
    });
  });

  it("resolves a published runtime that retains its route transaction receipt", () => {
    vi.mocked(deps.getSandbox!).mockReturnValue({
      ...openClawEntry(),
      reservationSessionId: "session-owner",
    });

    expect(resolveOrdinaryOpenClawPairingTarget(SANDBOX_NAME, deps)).toEqual({
      gatewayName: GATEWAY_NAME,
      openshellDriver: "docker",
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: FINGERPRINT,
      stateDirectory: "/sandbox/.openclaw",
      version: "1.0.0",
    });
  });

  it("keeps a published route receipt outside the readiness identity", () => {
    const agent = loadAgent("openclaw");
    expect(
      launchReadinessDigest(
        buildLaunchReadinessRegistryProjection(
          { ...openClawEntry(), reservationSessionId: "session-owner" },
          agent,
        ),
      ),
    ).toBe(launchReadinessDigest(buildLaunchReadinessRegistryProjection(openClawEntry(), agent)));
  });

  it("resolves a custom Dockerfile without inventing a managed agent version", () => {
    vi.mocked(deps.getSandbox!).mockReturnValue({
      ...openClawEntry(),
      agentVersion: null,
      nemoclawVersion: null,
      fromDockerfile: "/tmp/custom-openclaw/Dockerfile",
    });

    expect(resolveOrdinaryOpenClawPairingTarget(SANDBOX_NAME, deps)).toEqual({
      gatewayName: GATEWAY_NAME,
      openshellDriver: "docker",
      lifecycleGeneration: "generation-1",
      lifecycleLiveIdentityFingerprint: FINGERPRINT,
      stateDirectory: "/sandbox/.openclaw",
      version: "",
    });
  });

  it("rejects a managed workload whose agent version is missing", () => {
    vi.mocked(deps.getSandbox!).mockReturnValue({
      ...openClawEntry(),
      agentVersion: null,
    });

    expect(resolveOrdinaryOpenClawPairingTarget(SANDBOX_NAME, deps)).toBeNull();
  });

  it.each([
    ["missing agent identity", { agent: undefined }],
    ["pending route reservation", { pendingRouteReservation: true }],
    ["changed gateway binding", { gatewayName: "nemoclaw-8081" }],
    ["missing lifecycle generation", { lifecycleGeneration: undefined }],
  ])("rejects %s (#9844)", (_label, mutation) => {
    vi.mocked(deps.getSandbox!).mockReturnValue({
      ...openClawEntry(),
      ...mutation,
    } as SandboxEntry);

    expect(resolveOrdinaryOpenClawPairingTarget(SANDBOX_NAME, deps)).toBeNull();
  });

  it("returns no target when registry observation fails (#9844)", () => {
    vi.mocked(deps.getSandbox!).mockImplementation(() => {
      throw new Error("registry unavailable");
    });

    expect(resolveOrdinaryOpenClawPairingTarget(SANDBOX_NAME, deps)).toBeNull();
  });
});
