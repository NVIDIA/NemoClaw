// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { SandboxMessagingPlan } from "../../../messaging";
import {
  restoreChannelMessagingProviderAttachments,
  rollbackMessagingProviderAttachments,
  type MessagingProviderAttachmentReceipt,
} from "./attachments";

type OpenShellRunner = NonNullable<
  Parameters<typeof restoreChannelMessagingProviderAttachments>[4]
>;

function result(stdout = "", status = 0, stderr = "") {
  return {
    pid: 0,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal: null,
  };
}

function queuedRunner(results: ReturnType<typeof result>[]) {
  const run = vi.fn((..._args: unknown[]) => results.shift() ?? result());
  return { run: run as unknown as OpenShellRunner, spy: run };
}

function hermesDiscordPlan(): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: "hermes",
    workflow: "onboard",
    channels: [],
    disabledChannels: [],
    credentialBindings: [
      {
        channelId: "discord",
        credentialId: "botToken",
        sourceInput: "botToken",
        providerName: "alpha-discord-bridge",
        providerEnvKey: "DISCORD_BOT_TOKEN",
        placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
        credentialAvailable: true,
      },
    ],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

const EXACT_PROVIDER = [
  "Id: provider-alpha-discord",
  "Name: alpha-discord-bridge",
  "Type: discord-hermes-static-v1",
  "Resource version: 7",
  "Credential keys: DISCORD_BOT_TOKEN",
  "Config keys: <none>",
].join("\n");

const RECEIPT: MessagingProviderAttachmentReceipt = {
  credentialKey: "DISCORD_BOT_TOKEN",
  gatewayName: "nemoclaw-9090",
  providerId: "provider-alpha-discord",
  providerName: "alpha-discord-bridge",
  providerType: "discord-hermes-static-v1",
  resourceVersion: 7,
};

const ATTACHED_PROVIDER = [
  "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS",
  "alpha-discord-bridge discord-hermes-static-v1 1 0",
].join("\n");

describe("messaging provider attachment lifecycle", () => {
  it("restores an exact Hermes Discord provider before policy application", () => {
    const fixture = queuedRunner([
      result(EXACT_PROVIDER),
      result("No providers attached to sandbox alpha."),
      result(EXACT_PROVIDER),
      result("Attached provider alpha-discord-bridge"),
      result(ATTACHED_PROVIDER),
      result(EXACT_PROVIDER),
    ]);

    expect(
      restoreChannelMessagingProviderAttachments(
        "alpha",
        hermesDiscordPlan(),
        "discord",
        "nemoclaw-9090",
        fixture.run,
      ),
    ).toEqual([RECEIPT]);
    expect(fixture.spy.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "get", "-g", "nemoclaw-9090", "alpha-discord-bridge"],
      ["sandbox", "provider", "-g", "nemoclaw-9090", "list", "alpha"],
      ["provider", "get", "-g", "nemoclaw-9090", "alpha-discord-bridge"],
      ["sandbox", "provider", "-g", "nemoclaw-9090", "attach", "alpha", "alpha-discord-bridge"],
      ["sandbox", "provider", "-g", "nemoclaw-9090", "list", "alpha"],
      ["provider", "get", "-g", "nemoclaw-9090", "alpha-discord-bridge"],
    ]);
  });

  it("does not mutate an attachment that already exists", () => {
    const fixture = queuedRunner([
      result(EXACT_PROVIDER),
      result(ATTACHED_PROVIDER),
      result(EXACT_PROVIDER),
    ]);

    expect(
      restoreChannelMessagingProviderAttachments(
        "alpha",
        hermesDiscordPlan(),
        "discord",
        "nemoclaw-9090",
        fixture.run,
      ),
    ).toEqual([]);
    expect(fixture.spy.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "get", "-g", "nemoclaw-9090", "alpha-discord-bridge"],
      ["sandbox", "provider", "-g", "nemoclaw-9090", "list", "alpha"],
      ["provider", "get", "-g", "nemoclaw-9090", "alpha-discord-bridge"],
    ]);
  });

  it("rejects identity drift for an attachment that already exists", () => {
    const fixture = queuedRunner([
      result(EXACT_PROVIDER),
      result(ATTACHED_PROVIDER),
      result(EXACT_PROVIDER.replace("provider-alpha-discord", "provider-replacement")),
    ]);

    expect(() =>
      restoreChannelMessagingProviderAttachments(
        "alpha",
        hermesDiscordPlan(),
        "discord",
        "nemoclaw-9090",
        fixture.run,
      ),
    ).toThrow("changed across the attachment boundary");
    const commands = fixture.spy.mock.calls.map(([args]) => (args as string[]).join(" "));
    expect(commands.some((command) => command.includes(" attach "))).toBe(false);
    expect(commands.some((command) => command.includes(" detach "))).toBe(false);
  });

  it("does not inspect attachments for a channel without credential bindings", () => {
    const fixture = queuedRunner([]);

    expect(
      restoreChannelMessagingProviderAttachments(
        "alpha",
        hermesDiscordPlan(),
        "whatsapp",
        "nemoclaw-9090",
        fixture.run,
      ),
    ).toEqual([]);
    expect(fixture.spy).not.toHaveBeenCalled();
  });

  it("rejects a same-name provider with the wrong Hermes binding", () => {
    const fixture = queuedRunner([
      result(EXACT_PROVIDER.replace("discord-hermes-static-v1", "generic")),
    ]);

    expect(() =>
      restoreChannelMessagingProviderAttachments(
        "alpha",
        hermesDiscordPlan(),
        "discord",
        "nemoclaw-9090",
        fixture.run,
      ),
    ).toThrow(/does not match the required 'discord-hermes-static-v1'/u);
    expect(fixture.spy).toHaveBeenCalledTimes(1);
  });

  it("reports rollback failures without hiding successful absent detaches", () => {
    const teamsReceipt = {
      ...RECEIPT,
      providerId: "provider-alpha-teams",
      providerName: "alpha-teams-bridge",
    };
    const fixture = queuedRunner([
      result(
        EXACT_PROVIDER.replace("provider-alpha-discord", "provider-alpha-teams").replace(
          "alpha-discord-bridge",
          "alpha-teams-bridge",
        ),
      ),
      result("provider not attached", 1),
      result(EXACT_PROVIDER),
      result("gateway unavailable", 1),
    ]);

    expect(
      rollbackMessagingProviderAttachments("alpha", [RECEIPT, teamsReceipt], fixture.run),
    ).toEqual(["alpha-discord-bridge: gateway unavailable"]);
  });

  it("detaches a provisional attachment when confirmation fails", () => {
    const fixture = queuedRunner([
      result(EXACT_PROVIDER),
      result("No providers attached to sandbox alpha."),
      result(EXACT_PROVIDER),
      result("Attached provider alpha-discord-bridge"),
      result("gateway unavailable", 1),
      result(EXACT_PROVIDER),
      result("Detached provider alpha-discord-bridge"),
    ]);

    expect(() =>
      restoreChannelMessagingProviderAttachments(
        "alpha",
        hermesDiscordPlan(),
        "discord",
        "nemoclaw-9090",
        fixture.run,
      ),
    ).toThrow("gateway unavailable");
    expect(fixture.spy.mock.calls.at(-1)?.[0]).toEqual([
      "sandbox",
      "provider",
      "-g",
      "nemoclaw-9090",
      "detach",
      "alpha",
      "alpha-discord-bridge",
    ]);
  });

  it("detaches a provisional attachment when confirmation omits it", () => {
    const fixture = queuedRunner([
      result(EXACT_PROVIDER),
      result("No providers attached to sandbox alpha."),
      result(EXACT_PROVIDER),
      result("Attached provider alpha-discord-bridge"),
      result("No providers attached to sandbox alpha."),
      result(EXACT_PROVIDER),
      result("Detached provider alpha-discord-bridge"),
    ]);

    expect(() =>
      restoreChannelMessagingProviderAttachments(
        "alpha",
        hermesDiscordPlan(),
        "discord",
        "nemoclaw-9090",
        fixture.run,
      ),
    ).toThrow("did not confirm provider 'alpha-discord-bridge'");
    expect(fixture.spy.mock.calls.at(-1)?.[0]).toContain("detach");
  });

  it("does not attach or detach a provider replaced after the metadata precheck", () => {
    const fixture = queuedRunner([
      result(EXACT_PROVIDER),
      result("No providers attached to sandbox alpha."),
      result(EXACT_PROVIDER.replace("provider-alpha-discord", "provider-replacement")),
    ]);

    expect(() =>
      restoreChannelMessagingProviderAttachments(
        "alpha",
        hermesDiscordPlan(),
        "discord",
        "nemoclaw-9090",
        fixture.run,
      ),
    ).toThrow("changed across the attachment boundary");
    const commands = fixture.spy.mock.calls.map(([args]) => (args as string[]).join(" "));
    expect(commands.some((command) => command.includes(" attach "))).toBe(false);
    expect(commands.some((command) => command.includes(" detach "))).toBe(false);
  });

  it("refuses to detach a replacement provider during rollback", () => {
    const fixture = queuedRunner([
      result(EXACT_PROVIDER.replace("provider-alpha-discord", "provider-replacement")),
    ]);

    expect(rollbackMessagingProviderAttachments("alpha", [RECEIPT], fixture.run)).toEqual([
      "alpha-discord-bridge: provider identity changed; refusing detach",
    ]);
    expect(fixture.spy).toHaveBeenCalledTimes(1);
  });
});
