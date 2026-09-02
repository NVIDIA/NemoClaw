// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Lifecycle-boundary regression: `addSandboxChannel` must refuse channel/agent pairs
// that fall outside the channel manifest `supportedAgents` set BEFORE any preset load,
// policy mutation, provider upsert, registry write, credential prompt, or rebuild trigger.
// Without this gate, a destructive sandbox rebuild can run and fail late at
// Dockerfile patching.
//
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as runtime from "../../adapters/openshell/runtime";
import * as defs from "../../agent/defs";
import * as store from "../../credentials/store";
import * as policy from "../../policy";
import * as registry from "../../state/registry";
import { addSandboxChannel, startSandboxChannel, stopSandboxChannel } from "./policy-channel";
import { policyChannelDependencies } from "./policy-channel-dependencies";

function agentFixture(name: string): defs.AgentDefinition {
  return { name } as defs.AgentDefinition;
}

function successfulOpenshellResult(): ReturnType<typeof runtime.runOpenshell> {
  return {
    pid: 0,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
  };
}

let exitMock: MockInstance;
let errSpy: MockInstance;
let logSpy: MockInstance;
let getSandboxMock: MockInstance;
let upsertMock: MockInstance;
let updateSandboxMock: MockInstance;
let runOpenshellMock: MockInstance;
let applyPresetMock: MockInstance;
let loadPresetForSandboxMock: MockInstance;
let saveCredentialMock: MockInstance;
let getCredentialMock: MockInstance;
let promptMock: MockInstance;
let rebuildMock: MockInstance;

function exitCodeFromError(err: unknown): number | null {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/^process\.exit\((\d+)\)$/);
  return match ? Number(match[1]) : null;
}

beforeEach(() => {
  delete process.env.NEMOCLAW_NON_INTERACTIVE;

  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  exitMock = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);

  getSandboxMock = vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "da-test" });
  updateSandboxMock = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
  upsertMock = vi.spyOn(policyChannelDependencies, "upsertMessagingProviders").mockReturnValue([]);
  runOpenshellMock = vi.spyOn(runtime, "runOpenshell").mockReturnValue(successfulOpenshellResult());
  loadPresetForSandboxMock = vi
    .spyOn(policy, "loadPresetForSandbox")
    .mockReturnValue("network_policies:\n  stub: {}\n");
  vi.spyOn(policy, "parsePresetPolicyKeys").mockReturnValue(["stub"]);
  vi.spyOn(policy, "listPresets").mockReturnValue([]);
  applyPresetMock = vi.spyOn(policy, "applyPreset").mockReturnValue(true);
  vi.spyOn(policy, "getAppliedPresets").mockReturnValue([]);
  getCredentialMock = vi.spyOn(store, "getCredential").mockReturnValue(null);
  saveCredentialMock = vi.spyOn(store, "saveCredential").mockImplementation(() => undefined);
  promptMock = vi.spyOn(store, "prompt").mockResolvedValue("");
  rebuildMock = vi.spyOn(policyChannelDependencies, "rebuildSandbox").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("addSandboxChannel agent gate", () => {
  it("rejects an unknown agent before any preset, mutation, provider, credential, or rebuild call", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue(agentFixture("custom-agent"));

    let caught: unknown;
    try {
      await addSandboxChannel("da-test", { channel: "discord" });
    } catch (err) {
      caught = err;
    }

    expect(exitCodeFromError(caught)).toBe(1);
    const errorText = (errSpy.mock.calls as unknown[][])
      .map((call) => call.map(String).join(" "))
      .join("\n");
    expect(errorText).toContain("This channel does not support the configured agent.");
    expect(errorText).not.toContain("custom-agent");

    expect(loadPresetForSandboxMock).not.toHaveBeenCalled();
    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(updateSandboxMock).not.toHaveBeenCalled();
    expect(saveCredentialMock).not.toHaveBeenCalled();
    expect(getCredentialMock).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
    expect(rebuildMock).not.toHaveBeenCalled();
    expect(runOpenshellMock).not.toHaveBeenCalled();
  });

  it("rejects an agent that is not listed by any channel manifest before any mutation", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue(agentFixture("future-agent"));

    let caught: unknown;
    try {
      await addSandboxChannel("da-test", { channel: "telegram" });
    } catch (err) {
      caught = err;
    }

    expect(exitCodeFromError(caught)).toBe(1);
    expect(loadPresetForSandboxMock).not.toHaveBeenCalled();
    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(updateSandboxMock).not.toHaveBeenCalled();
    expect(rebuildMock).not.toHaveBeenCalled();
  });

  it("does not gate messaging-capable agents (openclaw flows past the agent check)", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue(agentFixture("openclaw"));

    let caught: unknown;
    try {
      await addSandboxChannel("da-test", { channel: "telegram" });
    } catch (err) {
      caught = err;
    }

    const errorText = (errSpy.mock.calls as unknown[][])
      .map((call) => call.map(String).join(" "))
      .join("\n");
    expect(errorText).not.toMatch(/does not support agent/);
    expect(loadPresetForSandboxMock).toHaveBeenCalled();
    void caught;
    void exitMock;
    void logSpy;
  });
});

describe("channel lifecycle agent gate", () => {
  it.each([
    ["start", ["googlechat"], () => startSandboxChannel("da-test", { channel: "googlechat" })],
    ["stop", [], () => stopSandboxChannel("da-test", { channel: "googlechat" })],
  ])("rejects a stale channel during %s before reading channel state or mutating the sandbox", async (_verb, disabledChannels, run) => {
    // googlechat now supports openclaw + hermes, so exercise the unsupported-pair
    // lifecycle gate with a non-messaging custom agent (supported by no channel).
    getSandboxMock.mockReturnValue({ name: "da-test", agent: "custom-agent" });
    vi.spyOn(defs, "loadAgent").mockReturnValue(agentFixture("custom-agent"));
    const configuredChannelsMock = vi
      .spyOn(registry, "getConfiguredMessagingChannelsFromEntry")
      .mockReturnValue(["googlechat"]);
    const disabledChannelsMock = vi
      .spyOn(registry, "getDisabledChannels")
      .mockReturnValue(disabledChannels);

    let caught: unknown;
    try {
      await run();
    } catch (err) {
      caught = err;
    }

    expect(exitCodeFromError(caught)).toBe(1);
    const errorText = (errSpy.mock.calls as unknown[][])
      .map((call) => call.map(String).join(" "))
      .join("\n");
    expect(errorText).toContain("This channel does not support the configured agent.");
    expect(errorText).not.toContain("custom-agent");

    expect(configuredChannelsMock).not.toHaveBeenCalled();
    expect(disabledChannelsMock).not.toHaveBeenCalled();
    expect(loadPresetForSandboxMock).not.toHaveBeenCalled();
    expect(applyPresetMock).not.toHaveBeenCalled();
    expect(updateSandboxMock).not.toHaveBeenCalled();
    expect(rebuildMock).not.toHaveBeenCalled();
    expect(runOpenshellMock).not.toHaveBeenCalled();
  });
});
