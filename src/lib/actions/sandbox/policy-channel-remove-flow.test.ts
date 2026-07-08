// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as policies from "../../policy";
import * as registry from "../../state/registry";
import { removeSandboxChannel, startSandboxChannel, stopSandboxChannel } from "./policy-channel";
import { policyChannelDependencies } from "./policy-channel-dependencies";

describe("policy channel remove/enable flows", () => {
  let exitSpy: MockInstance;
  let logSpy: MockInstance;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports remove usage and exits before touching channel state when no channel is supplied", async () => {
    await expect(removeSandboxChannel("alpha", {})).rejects.toThrow("process.exit(1)");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("supports a remove dry run without gateway, registry, or rebuild side effects", async () => {
    await expect(
      removeSandboxChannel("alpha", { channel: "telegram", dryRun: true }),
    ).resolves.toBeUndefined();

    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "--dry-run: would remove channel 'telegram' for 'alpha'.",
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("supports stop dry runs for configured channels", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha" });
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["telegram"]);
    vi.spyOn(registry, "getDisabledChannels").mockReturnValue([]);

    await expect(
      stopSandboxChannel("alpha", { channel: "telegram", dryRun: true }),
    ).resolves.toBeUndefined();

    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "--dry-run: would stop channel 'telegram' for 'alpha'.",
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("supports start dry runs without applying a preset or persisting the enabled plan", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha" });
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["telegram"]);
    vi.spyOn(registry, "getDisabledChannels").mockReturnValue(["telegram"]);
    const updateSandboxSpy = vi.spyOn(registry, "updateSandbox");
    const applyPresetSpy = vi.spyOn(policies, "applyPreset");
    const rebuildSpy = vi.spyOn(policyChannelDependencies, "rebuildSandbox");
    await expect(
      startSandboxChannel("alpha", { channel: "telegram", dryRun: true }),
    ).resolves.toBeUndefined();

    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "--dry-run: would start channel 'telegram' for 'alpha'.",
    );
    expect(applyPresetSpy).not.toHaveBeenCalled();
    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(rebuildSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
