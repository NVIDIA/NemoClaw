// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

const requireDist = createRequire(import.meta.url);
const policyChannelModulePath = "../../../../dist/lib/actions/sandbox/policy-channel.js";

type PolicyChannelModule = typeof import("../../../../dist/lib/actions/sandbox/policy-channel");

describe("policy channel remove/enable flows", () => {
  let exitSpy: MockInstance;
  let logSpy: MockInstance;

  beforeEach(() => {
    delete require.cache[requireDist.resolve(policyChannelModulePath)];
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[requireDist.resolve(policyChannelModulePath)];
  });

  it("reports remove usage and exits before touching channel state when no channel is supplied", async () => {
    const policyChannel = requireDist(policyChannelModulePath) as PolicyChannelModule;

    await expect(policyChannel.removeSandboxChannel("alpha", {})).rejects.toThrow(
      "process.exit(1)",
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("supports a remove dry run without gateway, registry, or rebuild side effects", async () => {
    const policyChannel = requireDist(policyChannelModulePath) as PolicyChannelModule;

    await expect(
      policyChannel.removeSandboxChannel("alpha", { channel: "telegram", dryRun: true }),
    ).resolves.toBeUndefined();

    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "--dry-run: would remove channel 'telegram' for 'alpha'.",
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("supports stop dry runs for configured channels", async () => {
    const registry = requireDist("../../../../dist/lib/state/registry.js");
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha" });
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["telegram"]);
    vi.spyOn(registry, "getDisabledChannels").mockReturnValue([]);
    const policyChannel = requireDist(policyChannelModulePath) as PolicyChannelModule;

    await expect(
      policyChannel.stopSandboxChannel("alpha", { channel: "telegram", dryRun: true }),
    ).resolves.toBeUndefined();

    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "--dry-run: would stop channel 'telegram' for 'alpha'.",
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
