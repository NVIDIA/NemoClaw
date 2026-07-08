// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session } from "../../../state/onboard-session";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

const registeredEntry = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  provider: "provider",
  model: "model",
  endpointUrl: null,
  credentialEnv: null,
  preferredInferenceApi: "openai-completions" as const,
  gatewayName: "nemoclaw",
  ...overrides,
});

describe("handleSandboxState tool disclosure", () => {
  it("fails closed without claiming an unregistered live sandbox as a managed migration", async () => {
    const session = createSession({ sandboxName: "saved", toolDisclosure: "progressive" });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: () => null,
    });

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a legacy managed image",
      createSession({ toolDisclosure: "progressive" }),
      undefined,
      "  [resume] Tool disclosure metadata is missing; recreating sandbox for one-time migration.",
    ],
    [
      "a changed selection",
      createSession({ toolDisclosure: "direct" }),
      "progressive" as const,
      "  [resume] Tool disclosure configuration changed; recreating sandbox.",
    ],
  ])("recreates instead of reusing %s tool disclosure", async (_label, session, recorded, note) => {
    session.sandboxName = "saved";
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: (name) =>
        registeredEntry(name, {
          nemoclawVersion: "0.1.0",
          toolDisclosure: recorded,
          fromDockerfile: null,
        }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.note).toHaveBeenCalledWith(note);
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalled();
  });

  it.each([
    ["progressive", "direct"],
    ["direct", "progressive"],
  ] as const)("passes resumed %s-to-%s tool-disclosure drift into the downstream create intent", async (recordedMode, requestedMode) => {
    const session = createSession({ sandboxName: "saved", toolDisclosure: requestedMode });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      updateSession: vi.fn(
        (mutator: (value: Session) => Session | void) => mutator(session) ?? session,
      ),
      getSandboxRegistryEntry: (name) =>
        registeredEntry(name, {
          nemoclawVersion: "0.1.0",
          toolDisclosure: recordedMode,
        }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalledWith(
      expect.anything(),
      "model",
      "provider",
      "openai-completions",
      "saved",
      null,
      [],
      null,
      null,
      null,
      { sandboxGpuEnabled: false, mode: "0" },
      null,
      [],
      null,
      { recreate: true, toolDisclosure: requestedMode, observabilityEnabled: false },
    );
  });

  it("recreates a legacy custom image so its tool-disclosure contract is validated", async () => {
    const session = createSession({ sandboxName: "saved", toolDisclosure: "progressive" });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: (name) =>
        registeredEntry(name, {
          nemoclawVersion: null,
          fromDockerfile: "/tmp/Dockerfile.custom",
        }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Tool disclosure metadata is missing; recreating sandbox for one-time migration.",
    );
    expect(calls.createSandbox).toHaveBeenCalled();
    expect(calls.removeSandbox).not.toHaveBeenCalled();
  });

  it("retains managed MCP registry fidelity until createSandbox can refuse generic migration", async () => {
    const session = createSession({ sandboxName: "saved", toolDisclosure: "progressive" });
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: (name) =>
        registeredEntry(name, {
          nemoclawVersion: "0.1.0",
          mcp: {
            version: 1,
            bridges: {
              fake: {
                server: "fake",
                agent: "openclaw",
                url: "https://mcp.example.test",
                env: [],
                policyName: "mcp-bridge-fake",
                addedAt: "2026-07-03T00:00:00.000Z",
              },
            },
          },
        }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalled();
  });
});
