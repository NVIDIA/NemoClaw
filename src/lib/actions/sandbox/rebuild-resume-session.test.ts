// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSession, MACHINE_SNAPSHOT_VERSION, type Session } from "../../state/onboard-session";
import type { RebuildResumeConfig } from "./rebuild-resume-config";
import { rewindSessionForRebuildResume } from "./rebuild-resume-session";

function createResumeConfig(overrides: Partial<RebuildResumeConfig> = {}): RebuildResumeConfig {
  return {
    agent: null,
    provider: "compatible-endpoint",
    model: "nvidia/nemotron-3",
    nimContainer: null,
    credentialEnv: "COMPATIBLE_API_KEY",
    preferredInferenceApi: "openai",
    compatibleEndpointReasoning: "true",
    pinEndpoint: true,
    endpointUrl: "https://new-provider.example/v1",
    registryInferenceRoute: null,
    ambient: { presentVars: [], agentMismatch: null },
    ...overrides,
  };
}

function markStep(session: Session, name: string, status: "complete" | "failed"): void {
  const step = session.steps[name];
  step.status = status;
  step.startedAt = "2026-06-01T00:00:00.000Z";
  step.completedAt = status === "complete" ? "2026-06-01T00:01:00.000Z" : null;
  step.error = status === "failed" ? "stale recreate failure" : null;
}

describe("rewindSessionForRebuildResume", () => {
  it("normalizes stale recreate snapshots to the pre-sandbox resume boundary without data loss", () => {
    const session = createSession({
      sandboxName: "old-name",
      provider: "old-provider",
      model: "old-model",
      endpointUrl: "https://old-provider.example/v1",
      credentialEnv: "OLD_PROVIDER_KEY",
      lastCompletedStep: "inference",
      lastStepStarted: "openclaw",
      resumable: false,
      status: "failed",
      failure: {
        step: "openclaw",
        message: "stale recreate failed",
        recordedAt: "2026-06-01T00:02:00.000Z",
      },
      agent: "stale-agent",
      machine: {
        version: MACHINE_SNAPSHOT_VERSION,
        state: "openclaw",
        stateEnteredAt: "2026-06-01T00:01:00.000Z",
        revision: 7,
      },
    });
    session.metadata.fromDockerfile = "/tmp/reviewed.Dockerfile";
    session.migratedLegacyValueHashes = { OLD_PROVIDER_KEY: "abc123" };
    markStep(session, "gateway", "complete");
    markStep(session, "inference", "complete");
    markStep(session, "openclaw", "failed");

    const originalSessionId = session.sessionId;
    const rewound = rewindSessionForRebuildResume(session, {
      sandboxName: "alpha",
      rebuildAgent: "openclaw",
      rebuildMessagingPlan: null,
      rebuildsHermesSandbox: false,
      rebuildHermesToolGateways: ["stale-gateway"],
      resumeConfig: createResumeConfig(),
    });

    expect(rewound).toBe(session);
    expect(rewound.sessionId).toBe(originalSessionId);
    expect(rewound.metadata.fromDockerfile).toBe("/tmp/reviewed.Dockerfile");
    expect(rewound.migratedLegacyValueHashes).toEqual({ OLD_PROVIDER_KEY: "abc123" });
    expect(rewound).toMatchObject({
      sandboxName: "alpha",
      resumable: true,
      status: "in_progress",
      failure: null,
      lastCompletedStep: "gateway",
      lastStepStarted: "gateway",
      agent: "openclaw",
      provider: "compatible-endpoint",
      model: "nvidia/nemotron-3",
      endpointUrl: "https://new-provider.example/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai",
      compatibleEndpointReasoning: "true",
      hermesToolGateways: [],
    });
    expect(rewound.machine).toMatchObject({
      version: MACHINE_SNAPSHOT_VERSION,
      state: "complete",
      revision: 8,
    });
    for (const stepName of [
      "provider_selection",
      "inference",
      "sandbox",
      "openclaw",
      "agent_setup",
      "policies",
    ]) {
      expect(rewound.steps[stepName]).toEqual({
        status: "pending",
        startedAt: null,
        completedAt: null,
        error: null,
      });
    }
  });

  it("clears reasoning state that came from an unrelated session", () => {
    const session = createSession({
      sandboxName: "other",
      compatibleEndpointReasoning: "true",
    });
    const resumeConfig = {
      ...createResumeConfig(),
      compatibleEndpointReasoning: null,
    };

    const rewound = rewindSessionForRebuildResume(session, {
      sandboxName: "alpha",
      rebuildAgent: "openclaw",
      rebuildMessagingPlan: null,
      rebuildsHermesSandbox: false,
      rebuildHermesToolGateways: [],
      resumeConfig,
    });

    expect(rewound.compatibleEndpointReasoning).toBeNull();
  });

  it("keeps the registry route handoff out of the persisted resume session", () => {
    const session = createSession({ sandboxName: "old-name" });
    const rewound = rewindSessionForRebuildResume(session, {
      sandboxName: "alpha",
      rebuildAgent: "openclaw",
      rebuildMessagingPlan: null,
      rebuildsHermesSandbox: false,
      rebuildHermesToolGateways: [],
      resumeConfig: createResumeConfig({
        registryInferenceRoute: {
          provider: "compatible-endpoint",
          model: "nvidia/nemotron-3",
          endpointUrl: "https://new-provider.example/v1",
          preferredInferenceApi: "openai",
          source: "registry",
        },
      }),
    });

    expect(rewound).not.toHaveProperty("registryInferenceRoute");
    expect(rewound).not.toHaveProperty("rebuildRegistryInferenceRoute");
    expect(rewound).toMatchObject({
      provider: "compatible-endpoint",
      model: "nvidia/nemotron-3",
      endpointUrl: "https://new-provider.example/v1",
    });
  });
});
