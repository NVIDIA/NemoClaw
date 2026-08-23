// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { SandboxMessagingPlan } from "../../messaging";
import {
  parseMessagingProviderAttachmentNames,
  restoreChannelMessagingProviderAttachments,
  rollbackMessagingProviderAttachments,
} from "./messaging-provider-attachments";

type OpenShellRunner = NonNullable<
  Parameters<typeof restoreChannelMessagingProviderAttachments>[3]
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
  "Name: alpha-discord-bridge",
  "Type: discord-hermes-static-v1",
  "Credential keys: DISCORD_BOT_TOKEN",
  "Config keys: <none>",
].join("\n");

const ATTACHED_PROVIDER = [
  "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS",
  "alpha-discord-bridge discord-hermes-static-v1 1 0",
].join("\n");

describe("messaging provider attachment lifecycle", () => {
  it("parses empty and populated OpenShell attachment lists", () => {
    expect(
      parseMessagingProviderAttachmentNames("No providers attached to sandbox alpha."),
    ).toEqual([]);
    expect(parseMessagingProviderAttachmentNames(ATTACHED_PROVIDER)).toEqual([
      "alpha-discord-bridge",
    ]);
  });

  it("restores an exact Hermes Discord provider before policy application", () => {
    const fixture = queuedRunner([
      result(EXACT_PROVIDER),
      result("No providers attached to sandbox alpha."),
      result("Attached provider alpha-discord-bridge"),
      result(ATTACHED_PROVIDER),
    ]);

    expect(
      restoreChannelMessagingProviderAttachments(
        "alpha",
        hermesDiscordPlan(),
        "discord",
        fixture.run,
      ),
    ).toEqual(["alpha-discord-bridge"]);
    expect(fixture.spy.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "get", "alpha-discord-bridge"],
      ["sandbox", "provider", "list", "alpha"],
      ["sandbox", "provider", "attach", "alpha", "alpha-discord-bridge"],
      ["sandbox", "provider", "list", "alpha"],
    ]);
  });

  it("does not mutate an attachment that already exists", () => {
    const fixture = queuedRunner([result(EXACT_PROVIDER), result(ATTACHED_PROVIDER)]);

    expect(
      restoreChannelMessagingProviderAttachments(
        "alpha",
        hermesDiscordPlan(),
        "discord",
        fixture.run,
      ),
    ).toEqual([]);
    expect(fixture.spy).toHaveBeenCalledTimes(2);
  });

  it("does not inspect attachments for a channel without credential bindings", () => {
    const fixture = queuedRunner([]);

    expect(
      restoreChannelMessagingProviderAttachments(
        "alpha",
        hermesDiscordPlan(),
        "whatsapp",
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
        fixture.run,
      ),
    ).toThrow(/does not match the required 'discord-hermes-static-v1'/u);
    expect(fixture.spy).toHaveBeenCalledTimes(1);
  });

  it("reports rollback failures without hiding successful absent detaches", () => {
    const fixture = queuedRunner([
      result("provider not attached", 1),
      result("gateway unavailable", 1),
    ]);

    expect(
      rollbackMessagingProviderAttachments(
        "alpha",
        ["alpha-discord-bridge", "alpha-teams-bridge"],
        fixture.run,
      ),
    ).toEqual(["alpha-discord-bridge: gateway unavailable"]);
  });
});
