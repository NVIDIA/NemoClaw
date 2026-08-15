// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { decisionSelected } from "../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../state/onboard-checkpoint-migrate";
import { createSession } from "../state/onboard-session";
import { clearAgentScopedResumeState } from "./agent-resume-state";
import { checkpointSandboxIdentityMatches } from "./checkpoint-replay";

describe("clearAgentScopedResumeState", () => {
  it("invalidates agent-scoped checkpoint decisions and effect receipts", () => {
    const session = createSession({
      agent: null,
      sandboxName: "my-sandbox",
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: true,
        resourceProfile: true,
      },
    });
    session.checkpoint = {
      ...deriveCheckpointFromSession(session),
      sandboxIdentity: decisionSelected({ name: "my-sandbox", agent: "openclaw" }),
      resourceProfile: decisionSelected({ cpu: "4", memory: "8Gi" }),
      effectGroups: {
        sandbox_create: { completedAt: session.updatedAt, fingerprint: "create" },
        sandbox_register: { completedAt: session.updatedAt, fingerprint: "register" },
      },
      bindings: {
        credentialEnvs: ["SLACK_TOKEN"],
        registeredProviders: [
          { name: "my-sandbox-slack", type: "generic", credentialEnv: "SLACK_TOKEN" },
        ],
      },
    };

    clearAgentScopedResumeState(session, "hermes");

    expect(session.checkpoint).toMatchObject({
      sandboxIdentity: { kind: "unset" },
      webSearch: { kind: "unset" },
      messaging: { kind: "unset" },
      effectGroups: {},
      bindings: { credentialEnvs: [], registeredProviders: [] },
    });
    expect(session.checkpoint?.resourceProfile.kind).not.toBe("unset");
  });

  it("invalidates a legacy sandbox identity when the selected agent changes", () => {
    const session = createSession({
      sandboxName: "my-sandbox",
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: true,
        messaging: true,
        resourceProfile: true,
      },
    });

    clearAgentScopedResumeState(session, "hermes");

    expect(session.checkpoint).toBeNull();
    expect(session.sandboxPromptProgress.sandboxName).toBe(false);
    expect(checkpointSandboxIdentityMatches(session, "my-sandbox")).toBe(false);
  });
});
