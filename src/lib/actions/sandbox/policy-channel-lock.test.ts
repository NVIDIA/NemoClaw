// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as defs from "../../agent/defs";
import * as policies from "../../policy";
import * as registry from "../../state/registry";

const lockMocks = vi.hoisted(() => ({
  withMcpLifecycleLock: vi.fn(async (_sandboxName: string, operation: () => unknown) =>
    operation(),
  ),
  withSandboxMutationLock: vi.fn(async () => undefined),
}));

vi.mock("../../state/mcp-lifecycle-lock", () => lockMocks);

import {
  addSandboxChannel,
  addSandboxPolicy,
  excludeSandboxBaseline,
  removeSandboxChannel,
  removeSandboxPolicy,
  restoreSandboxBaseline,
  startSandboxChannel,
  stopSandboxChannel,
} from "./policy-channel";

describe("policy and channel sandbox mutation locking", () => {
  beforeEach(() => {
    lockMocks.withSandboxMutationLock.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(defs, "loadAgent").mockReturnValue({ name: "hermes" } as defs.AgentDefinition);
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "alpha",
      agent: "hermes",
    });
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["telegram"]);
    vi.spyOn(registry, "getDisabledChannels").mockReturnValue(["telegram"]);

    vi.spyOn(policies, "listPresets").mockReturnValue([
      { file: "pypi.yaml", name: "pypi", description: "Python Package Index access" },
    ]);
    vi.spyOn(policies, "listCustomPresets").mockReturnValue([]);
    vi.spyOn(policies, "getAppliedPresets").mockReturnValue(["pypi"]);
    vi.spyOn(policies, "getGatewayPresets").mockReturnValue(null);
    vi.spyOn(policies, "loadPresetForSandbox").mockImplementation(
      (_sandboxName, presetName) =>
        `network_policies:\n  ${presetName}:\n    name: ${presetName}\n    endpoints:\n      - host: example.com\n        port: 443\n`,
    );
    vi.spyOn(policies, "parsePresetPolicyKeys").mockReturnValue(["telegram"]);
    vi.spyOn(policies, "getPresetContentGatewayState").mockReturnValue("absent");
    vi.spyOn(policies, "getPresetValidationWarning").mockReturnValue(null);
    vi.spyOn(policies, "getPresetEndpoints").mockReturnValue(["example.com"]);
    vi.spyOn(policies, "resolveSandboxBaselinePolicy").mockReturnValue({
      agent: "hermes",
      policyPath: "/repo/policy-additions.yaml",
      content: "version: 1\nnetwork_policies: {}\n",
    });
    vi.spyOn(policies, "getSandboxBaselineEntry").mockReturnValue({
      name: "nous_research",
      endpoints: [{ host: "nousresearch.com", port: 443 }],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["policy add", () => addSandboxPolicy("alpha")],
    ["policy remove", () => removeSandboxPolicy("alpha")],
    ["channel add", () => addSandboxChannel("alpha")],
    ["channel remove", () => removeSandboxChannel("alpha")],
    ["channel start", () => startSandboxChannel("alpha")],
    ["channel stop", () => stopSandboxChannel("alpha")],
  ])("routes %s through the shared per-sandbox lock", async (_label, action) => {
    await action();

    expect(lockMocks.withSandboxMutationLock).toHaveBeenCalledOnce();
    expect(lockMocks.withSandboxMutationLock).toHaveBeenCalledWith("alpha", expect.any(Function));
  });

  it.each([
    ["policy add", () => addSandboxPolicy("alpha", { preset: "pypi", dryRun: true })],
    ["policy remove", () => removeSandboxPolicy("alpha", { preset: "pypi", dryRun: true })],
    [
      "policy exclude",
      () => excludeSandboxBaseline("alpha", { key: "nous_research", dryRun: true }),
    ],
    [
      "policy restore",
      () => restoreSandboxBaseline("alpha", { key: "nous_research", dryRun: true }),
    ],
    ["channel add", () => addSandboxChannel("alpha", { channel: "telegram", dryRun: true })],
    ["channel remove", () => removeSandboxChannel("alpha", { channel: "telegram", dryRun: true })],
    ["channel start", () => startSandboxChannel("alpha", { channel: "telegram", dryRun: true })],
    [
      "channel stop",
      async () => {
        vi.mocked(registry.getDisabledChannels).mockReturnValue([]);
        await stopSandboxChannel("alpha", { channel: "telegram", dryRun: true });
      },
    ],
  ])("previews %s without taking the mutation lock (#8877)", async (_label, action) => {
    await action();

    expect(lockMocks.withSandboxMutationLock).not.toHaveBeenCalled();
  });
});
