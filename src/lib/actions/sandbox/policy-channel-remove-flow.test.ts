// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as policies from "../../policy";
import * as runner from "../../runner";
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

  it("supports start dry runs without applying a preset or persisting the enabled plan, and discloses effective egress first (#7179)", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha" });
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["telegram"]);
    vi.spyOn(registry, "getDisabledChannels").mockReturnValue(["telegram"]);
    const updateSandboxSpy = vi.spyOn(registry, "updateSandbox");
    const applyPresetSpy = vi.spyOn(policies, "applyPreset");
    const rebuildSpy = vi.spyOn(policyChannelDependencies, "rebuildSandbox");
    vi.spyOn(runner, "runCapture").mockReturnValue("version: 1\nnetwork_policies: {}\n");
    await expect(
      startSandboxChannel("alpha", { channel: "telegram", dryRun: true }),
    ).resolves.toBeUndefined();

    const lines = logSpy.mock.calls.map((call) => call.map(String).join(" "));
    const joined = lines.join("\n");
    expect(joined).toContain("Effective egress that would be opened:");
    expect(joined).toContain("- api.telegram.org:443 (protocol: rest, enforcement: enforce)");
    const scopeHeader = lines.findIndex((line) =>
      line.includes("Effective egress that would be opened:"),
    );
    const wouldStart = lines.findIndex((line) => line.includes("--dry-run: would start channel"));
    expect(scopeHeader).toBeGreaterThan(-1);
    expect(wouldStart).toBeGreaterThan(scopeHeader);
    expect(applyPresetSpy).not.toHaveBeenCalled();
    expect(updateSandboxSpy).not.toHaveBeenCalled();
    expect(rebuildSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not claim new egress on a start dry run when the preset already matches the live policy (#7179)", async () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "alpha" });
    vi.spyOn(registry, "getConfiguredMessagingChannelsFromEntry").mockReturnValue(["telegram"]);
    vi.spyOn(registry, "getDisabledChannels").mockReturnValue(["telegram"]);
    const liveTelegramPolicy = [
      "version: 1",
      "network_policies:",
      "  telegram_bot:",
      "    name: telegram_bot",
      "    endpoints:",
      "      - host: api.telegram.org",
      "        port: 443",
      "        protocol: rest",
      "        enforcement: enforce",
      "        rules:",
      "          - allow: { method: GET, path: '/bot*/**' }",
      "          - allow: { method: POST, path: '/bot*/**' }",
      "          - allow: { method: GET, path: '/file/bot*/**' }",
      "    binaries:",
      "      - { path: /usr/local/bin/node }",
      "      - { path: /usr/bin/node }",
      "",
    ].join("\n");
    vi.spyOn(runner, "runCapture").mockReturnValue(liveTelegramPolicy);

    await expect(
      startSandboxChannel("alpha", { channel: "telegram", dryRun: true }),
    ).resolves.toBeUndefined();

    const joined = logSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(joined).not.toContain("Effective egress that would be opened:");
    expect(joined).toContain("is already effective; no new egress would be opened.");
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
