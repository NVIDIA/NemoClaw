// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../messaging/manifest";
import {
  ensureMessagingHostForwardIfConfigured,
  resolveProductionForwardServiceGatewayName,
  resolveMessagingHostForward,
} from "./messaging-host-forward";

describe("production ForwardTcp gateway binding", () => {
  it.each([
    [undefined, "nemoclaw"],
    [{ gatewayName: "nemoclaw-18080" }, "nemoclaw-18080"],
    [{ gatewayName: "wrong", gatewayPort: 18_080 }, "nemoclaw-18080"],
    [{ gatewayPort: 8_080 }, "nemoclaw"],
    [{ gatewayPort: 0 }, "invalid"],
  ])("derives the canonical gateway from %j", (sandbox, expected) => {
    expect(resolveProductionForwardServiceGatewayName(sandbox)).toBe(expected);
  });
});

function makePlan(
  channel: Partial<SandboxMessagingPlan["channels"][number]> = {},
): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "demo",
    agent: "openclaw",
    workflow: "onboard",
    channels: [
      {
        channelId: "teams",
        displayName: "Microsoft Teams",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
        hostForward: {
          channelId: "teams",
          port: 3978,
          label: "Microsoft Teams webhook",
        },
        ...channel,
      },
    ],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function makeCompactTeamsPlan(): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "ms",
    agent: "hermes",
    workflow: "onboard",
    disabledChannels: [],
    networkPolicy: {
      presets: ["teams"],
      entries: [
        {
          channelId: "teams",
          presetName: "teams",
          policyKeys: ["teams"],
          source: "manifest",
        },
      ],
    },
    channels: [
      {
        channelId: "teams",
        active: true,
        configured: true,
        disabled: false,
        inputs: [
          { inputId: "allowedUsers", value: "user-id" },
          { inputId: "appId", value: "app-id" },
          { inputId: "clientSecret", credentialAvailable: true },
          { inputId: "requireMention", value: "1" },
          { inputId: "tenantId", value: "tenant-id" },
          { inputId: "webhookPort", value: "3978" },
        ],
      },
    ],
    credentialBindings: [],
  } as unknown as SandboxMessagingPlan;
}

describe("ensureMessagingHostForwardIfConfigured", () => {
  it("resolves compact persisted messaging host forwards", () => {
    expect(resolveMessagingHostForward(makeCompactTeamsPlan())).toEqual({
      channelId: "teams",
      port: 3978,
      label: "Microsoft Teams webhook",
    });
  });

  it("fails closed when persisted messaging plans are malformed", () => {
    expect(
      resolveMessagingHostForward({
        ...makePlan(),
        channels: [null],
      } as unknown as SandboxMessagingPlan),
    ).toBeNull();
  });

  it("starts the active messaging host forward", () => {
    const ensureForward = vi.fn(() => true);
    const note = vi.fn();

    const ok = ensureMessagingHostForwardIfConfigured({
      sandboxName: "demo",
      plan: makePlan(),
      ensureForward,
      note,
    });

    expect(ok).toBe(true);
    expect(ensureForward).toHaveBeenCalledWith("demo", 3978, "Microsoft Teams webhook");
    expect(note).toHaveBeenCalledWith(
      "  ✓ Microsoft Teams webhook forwarded at http://127.0.0.1:3978/",
    );
  });

  it("hydrates compact persisted plans before starting the host forward", () => {
    const ensureForward = vi.fn(() => true);
    const note = vi.fn();

    const ok = ensureMessagingHostForwardIfConfigured({
      sandboxName: "ms",
      plan: makeCompactTeamsPlan(),
      ensureForward,
      note,
    });

    expect(ok).toBe(true);
    expect(ensureForward).toHaveBeenCalledWith("ms", 3978, "Microsoft Teams webhook");
    expect(note).toHaveBeenCalledWith(
      "  ✓ Microsoft Teams webhook forwarded at http://127.0.0.1:3978/",
    );
  });

  it("skips disabled messaging channels", () => {
    const ensureForward = vi.fn(() => true);
    const note = vi.fn();

    const ok = ensureMessagingHostForwardIfConfigured({
      sandboxName: "demo",
      plan: makePlan({ active: false, disabled: true }),
      ensureForward,
      note,
    });

    expect(ok).toBe(true);
    expect(ensureForward).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it("returns false when the forward cannot be started", () => {
    const ensureForward = vi.fn(() => false);
    const note = vi.fn();

    const ok = ensureMessagingHostForwardIfConfigured({
      sandboxName: "demo",
      plan: makePlan(),
      ensureForward,
      note,
    });

    expect(ok).toBe(false);
    expect(note).not.toHaveBeenCalled();
  });

  it("reports and exits when the forward cannot be started", () => {
    const ensureForward = vi.fn(() => false);
    const errors: string[] = [];

    expect(() =>
      ensureMessagingHostForwardIfConfigured({
        sandboxName: "demo",
        plan: makePlan(),
        ensureForward,
        note: vi.fn(),
        rollbackOnFailure: {
          cliName: () => "nemoclaw",
          error: (message = "") => errors.push(message),
          exit: (code) => {
            throw new Error(`process.exit(${code})`);
          },
          buildRollbackMessage: (_sandboxName, err) => [
            "rollback:manual",
            err instanceof Error ? err.message : String(err),
          ],
        },
      }),
    ).toThrow("process.exit(1)");

    expect(errors.join("\n")).toContain("rollback:manual");
    expect(errors.join("\n")).toContain(
      "Failed to start Microsoft Teams webhook forward on port 3978",
    );
  });
});
