// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { MessagingSetupApplier } from "../../messaging/applier/setup-applier";
import { compactSandboxMessagingPlanForPersistence } from "../../messaging/persistence";
import type { SandboxMessagingState } from "../../state/registry-messaging";
import { hermesSnapshot, snapshot } from "./export-source-test-fixture";

function observedMessaging(agent: "openclaw" | "hermes", messaging: unknown) {
  const observed = agent === "hermes" ? hermesSnapshot() : snapshot();
  return {
    ...observed,
    registry: { ...observed.registry, messaging: messaging as SandboxMessagingState },
  };
}

describe.each(["openclaw", "hermes"] as const)("%s messaging export", (agent) => {
  const empty = MessagingSetupApplier.emptyPlan("alpha", agent);
  it.each([
    { label: "an empty full plan", plan: empty },
    { label: "an empty compact plan", plan: compactSandboxMessagingPlanForPersistence(empty) },
    {
      label: "an empty runtime setup",
      plan: { ...empty, runtimeSetup: { nodePreloads: [], envAliases: [], secretScans: [] } },
    },
    { label: "all channels removed", plan: { ...empty, workflow: "remove-channel" } },
    ...(["add-channel", "start-channel", "stop-channel", "rebuild"] as const).map((workflow) => ({
      label: `an empty ${workflow} plan`,
      plan: { ...empty, workflow },
    })),
  ])("exports a sandbox with $label", async ({ plan }) => {
    const result = await exportSnapshots([observedMessaging(agent, { schemaVersion: 1, plan })]);
    const withoutMessaging = await exportSnapshots([observedMessaging(agent, undefined)]);

    expect(result.outcome).toEqual({ ok: true, completion: { kind: "stdout" } });
    expect(result.writeStdout.mock.calls).toEqual(withoutMessaging.writeStdout.mock.calls);
    expect(result.publish).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing plan", change: { plan: undefined } },
    { label: "unknown state schema", change: { schemaVersion: 2 } },
    { label: "unknown plan schema", planChange: { schemaVersion: 2 } },
    { label: "unsupported workflow", planChange: { workflow: "unknown" } },
    { label: "empty workflow", planChange: { workflow: "" } },
    { label: "missing workflow", planChange: { workflow: undefined } },
    { label: "malformed workflow", planChange: { workflow: 1 } },
    { label: "foreign sandbox", planChange: { sandboxName: "foreign" } },
    { label: "foreign agent", planChange: { agent: "foreign" } },
    { label: "missing channels", planChange: { channels: undefined } },
    { label: "malformed channels", planChange: { channels: {} } },
    {
      label: "configured channel",
      planChange: { channels: [{ channelId: "telegram", configured: true }] },
    },
    {
      label: "disabled channel",
      planChange: {
        channels: [{ channelId: "telegram", configured: true, disabled: true, active: false }],
        disabledChannels: ["telegram"],
      },
    },
    {
      label: "pending channel removal",
      planChange: {
        channels: [{ channelId: "telegram", configured: false, pendingRemoval: true }],
      },
    },
    {
      label: "retained credential binding",
      planChange: { credentialBindings: [{ channelId: "telegram", credentialAvailable: false }] },
    },
    {
      label: "retained policy preset",
      planChange: { networkPolicy: { presets: ["telegram"], entries: [] } },
    },
    {
      label: "retained policy entry",
      planChange: { networkPolicy: { presets: [], entries: [{ channelId: "telegram" }] } },
    },
    {
      label: "malformed policy presets",
      planChange: { networkPolicy: { presets: {}, entries: [] } },
    },
    {
      label: "retained agent render",
      planChange: { agentRender: [{ channelId: "telegram", agent }] },
    },
    { label: "retained build step", planChange: { buildSteps: [{ channelId: "telegram" }] } },
    { label: "retained state update", planChange: { stateUpdates: [{ channelId: "telegram" }] } },
    { label: "retained health check", planChange: { healthChecks: [{ channelId: "telegram" }] } },
    {
      label: "retained runtime setup",
      planChange: {
        runtimeSetup: {
          nodePreloads: [{ channelId: "telegram" }],
          envAliases: [],
          secretScans: [],
        },
      },
    },
    { label: "unknown plan field", planChange: { unknown: true } },
    { label: "unknown state field", change: { unknown: true } },
  ])("rejects a $label without publishing", async ({ change, planChange }) => {
    const result = await exportSnapshots([
      observedMessaging(agent, {
        schemaVersion: 1,
        plan: { ...MessagingSetupApplier.emptyPlan("alpha", agent), ...planChange },
        ...change,
      }),
    ]);

    expect(result.outcome).toMatchObject({
      ok: false,
      failure: {
        kind: "observation",
        findings: expect.arrayContaining([
          expect.objectContaining({
            category: "unsupported",
            field: "spec.sandboxes[].integrations.messaging",
          }),
        ]),
      },
    });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });
});
