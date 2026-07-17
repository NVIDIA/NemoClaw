// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { decisionSelected, decisionUnset } from "../../../state/onboard-checkpoint-decision";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type OnboardCheckpoint,
} from "../../../state/onboard-checkpoint-types";
import { createSession, type Session } from "../../../state/onboard-session";
import { detectMessagingChannelsFromEnv } from "../../messaging-channel-setup";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

vi.mocked(detectMessagingChannelsFromEnv).mockReturnValue([]);

function crashedCheckpoint(overrides: Partial<OnboardCheckpoint> = {}): OnboardCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sessionId: "sess-1",
    machineState: "sandbox",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sandboxIdentity: decisionSelected({ name: "my-assistant", agent: "openclaw" }),
    webSearch: decisionUnset(),
    messaging: decisionUnset(),
    resourceProfile: decisionUnset(),
    effectGroups: {
      sandbox_create: { completedAt: "2026-01-01T00:00:00.000Z", fingerprint: "fp" },
    },
    bindings: { credentialEnvs: [], registeredProviders: [] },
    ...overrides,
  };
}

function sessionWithCheckpoint(checkpoint: OnboardCheckpoint): Session {
  const session = createSession({
    sessionId: "sess-1",
    agent: "openclaw",
    sandboxName: "my-assistant",
    sandboxPromptProgress: {
      sandboxName: true,
      webSearch: false,
      messaging: false,
      resourceProfile: false,
    },
  });
  session.checkpoint = checkpoint;
  return session;
}

describe("sandbox crash-recovery replay (#5961, #6228)", () => {
  it("reuses a surviving sandbox instead of recreating it under a stale step-incomplete decision", async () => {
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "ready" });
    const session = sessionWithCheckpoint(crashedCheckpoint());

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.recordSkip).toHaveBeenCalled();
  });

  it("recreates only under the recorded durable identity when the sandbox is gone", async () => {
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "missing" });
    const session = sessionWithCheckpoint(crashedCheckpoint());

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.createSandbox).toHaveBeenCalled();
    expect((calls.createSandbox.mock.calls[0] as unknown[] | undefined)?.[4]).toBe("my-assistant");
  });

  it("rejects stale bindings before any mutation instead of guessing", async () => {
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "missing" });
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        bindings: { credentialEnvs: ["OPENAI_API_KEY"], registeredProviders: [] },
      }),
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
        env: {},
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.error.mock.calls.flat().join("\n")).toContain("OPENAI_API_KEY");
  });

  it("does not engage the crash-recovery path for a normal fresh create (no checkpoint receipt)", async () => {
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "missing" });
    const session = createSession({ sessionId: "sess-1", agent: "openclaw" });

    await handleSandboxState({ ...baseOptions(deps, session), resume: false });

    expect(calls.createSandbox).toHaveBeenCalled();
  });

  it("reuses a live sandbox even when the create receipt was lost in the crash window (#7022)", async () => {
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "ready" });
    const session = sessionWithCheckpoint(crashedCheckpoint({ effectGroups: {} }));

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.recordSkip).toHaveBeenCalled();
  });

  it("does not reuse a live sandbox when the checkpoint identity does not match the resume target", async () => {
    const { deps, calls } = createDeps({ getSandboxReuseState: () => "ready" });
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        sandboxIdentity: decisionSelected({ name: "other-assistant", agent: "openclaw" }),
      }),
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.createSandbox).toHaveBeenCalled();
    expect(calls.recordSkip).not.toHaveBeenCalled();
  });

  it("rejects reuse when a checkpointed provider is no longer live-registered with the gateway", async () => {
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "missing",
      providerExistsInGateway: () => false,
    });
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        bindings: { credentialEnvs: [], registeredProviders: ["my-assistant-brave-search"] },
      }),
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.error.mock.calls.flat().join("\n")).toContain("my-assistant-brave-search");
  });

  it("accepts a checkpointed provider that is still live-registered with the gateway", async () => {
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      providerExistsInGateway: (name) => name === "my-assistant-brave-search",
    });
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        bindings: { credentialEnvs: [], registeredProviders: ["my-assistant-brave-search"] },
      }),
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.recordSkip).toHaveBeenCalled();
  });

  it("falls back to the staged-provider receipt when no live gateway check is wired", async () => {
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      providerExistsInGateway: undefined,
    });
    const session = sessionWithCheckpoint(
      crashedCheckpoint({
        bindings: { credentialEnvs: [], registeredProviders: ["my-assistant-brave-search"] },
      }),
    );
    session.stagedCredentialProviders = ["my-assistant-brave-search"];

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.recordSkip).toHaveBeenCalled();
  });

  it("records durable sandbox identity for a non-OpenClaw agent create so a crash can still be recovered", async () => {
    const { deps, getSession } = createDeps({ getSandboxReuseState: () => "missing" });
    const session = createSession({ sessionId: "sess-1", agent: "hermes" });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: false,
      agent: { name: "hermes" },
      sandboxName: "my-assistant",
    });

    expect(getSession().checkpoint?.sandboxIdentity).toEqual(
      decisionSelected({ name: "my-assistant", agent: "hermes" }),
    );
  });
});
