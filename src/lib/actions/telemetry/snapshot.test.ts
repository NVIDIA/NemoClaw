// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { imageRef, managedWorkload } from "../../domain/config/export-source-test-fixture";
import { parseTelemetryEvent } from "../../domain/telemetry/event";
import { SANDBOX_SIGNALS } from "../../domain/telemetry/observations";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import type { SandboxEntry } from "../../state/registry/types";
import * as configIo from "../../state/config-io";
import { loadCompleteRegistrySnapshot } from "../../state/registry/persistence";
import { MAX_TELEMETRY_BATCH_EVENTS, projectPublishedTelemetrySnapshot } from "./snapshot";

const publicModelCodes = { qwen: "qwen3_6_27b_fp8" };

function entry(name: string, overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name,
    agent: "openclaw",
    model: "Qwen/Qwen3.6-27B-FP8",
    provider: "nvidia-prod",
    preferredInferenceApi: "openai-completions",
    openshellDriver: "docker",
    sandboxGpuEnabled: false,
    webSearchEnabled: true,
    observabilityEnabled: false,
    ...overrides,
  };
}

function snapshot(...rows: SandboxEntry[]) {
  return {
    defaultSandbox: "unrelated-default",
    sandboxes: Object.fromEntries(rows.map((row) => [row.name, row])),
  };
}

function messagingPlan(sandboxName: string, channels: readonly string[]): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow: "onboard",
    channels: channels.map((channelId) => ({
      channelId,
      displayName: "private-display",
      authMode: "none",
      active: false,
      selected: false,
      configured: true,
      disabled: true,
      inputs: [],
      hooks: [],
    })),
    disabledChannels: [...channels],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

describe("published telemetry snapshot", () => {
  it("reports zero environments without inventing agents or routes (#10442)", () => {
    expect(projectPublishedTelemetrySnapshot("destroy", snapshot())).toEqual([
      { event: "nemoclaw_sandbox_count_observed", operation: "destroy", count: 0 },
    ]);
  });

  it("excludes pending rows and records each published primary configuration once (#10442)", () => {
    const events = projectPublishedTelemetrySnapshot(
      "onboard",
      snapshot(
        entry("private-first"),
        entry("private-second", { agent: "hermes", provider: undefined, model: undefined }),
        entry("private-pending", { pendingRouteReservation: true }),
      ),
    );
    expect(events?.[0]).toEqual({
      event: "nemoclaw_sandbox_count_observed",
      operation: "onboard",
      count: 2,
    });
    const records = events?.filter((event) => event.event === "nemoclaw_configuration_completed");
    expect(records).toHaveLength(2);
    expect(records?.every((event) => event.scope === "published_configuration")).toBe(true);
    expect(events?.filter((event) => event.event === "nemoclaw_agent_runtime_observed")).toEqual([
      {
        event: "nemoclaw_agent_runtime_observed",
        operation: "onboard",
        agent_runtime: "openclaw",
        count: 1,
      },
      {
        event: "nemoclaw_agent_runtime_observed",
        operation: "onboard",
        agent_runtime: "hermes",
        count: 1,
      },
    ]);
    expect(events?.filter((event) => event.event === "nemoclaw_model_observed")).toHaveLength(1);
    expect(events?.every((event) => parseTelemetryEvent(event) !== null)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private-");
  });

  it.each(Object.keys(SANDBOX_SIGNALS))(
    "reconciles sandbox signal %s with the published environment count (#10448)",
    (signal) => {
      const events = projectPublishedTelemetrySnapshot(
        "rebuild",
        snapshot(
          entry("alpha", {
            openshellDriver: "podman",
            sandboxGpuEnabled: true,
            webSearchEnabled: false,
            appliedPolicySelection: {
              schemaVersion: 1,
              source: "verified_selection",
              tier: "balanced",
            },
          }),
          entry("beta", { openshellDriver: "kubernetes", observabilityEnabled: true }),
          entry("gamma", { openshellDriver: undefined, sandboxGpuEnabled: undefined }),
        ),
      );
      expect(events).not.toBeNull();
      const counts = events?.filter(
        (event) =>
          event.event === "nemoclaw_configuration_observed" &&
          event.scope === "sandbox" &&
          event.signal === signal,
      );
      const total = counts?.reduce((sum, event) => sum + ("count" in event ? event.count : 0), 0);
      expect(total).toBe(3);
      expect(events).toContainEqual({
        event: "nemoclaw_configuration_observed",
        operation: "rebuild",
        scope: "sandbox",
        signal: "policy_tier",
        value: "unknown",
        count: 3,
      });
      expect(events).toContainEqual({
        event: "nemoclaw_configuration_observed",
        operation: "rebuild",
        scope: "sandbox",
        signal: "compute_driver",
        value: "unknown",
        count: 1,
      });
    },
  );

  it("reports a policy tier only for the target with current matching selection authority (#10448)", () => {
    const selection = { schemaVersion: 1, source: "verified_selection", tier: "balanced" } as const;
    const events = projectPublishedTelemetrySnapshot(
      "onboard",
      snapshot(
        entry("alpha", { appliedPolicySelection: selection }),
        entry("beta", { appliedPolicySelection: selection }),
      ),
      { name: "alpha", agent: "openclaw", appliedPolicySelection: selection },
    );
    expect(
      events
        ?.filter((event) => event.event === "nemoclaw_configuration_completed")
        .map((event) => ({
          value: event.configuration.policyTier,
          status: event.configuration.policyTierStatus,
        })),
    ).toEqual([
      { value: "balanced", status: "reported" },
      { value: null, status: "not_observed" },
    ]);
    expect(events).toContainEqual({
      event: "nemoclaw_configuration_observed",
      operation: "onboard",
      scope: "sandbox",
      signal: "policy_tier",
      value: "balanced",
      count: 1,
    });
    expect(events).toContainEqual({
      event: "nemoclaw_configuration_observed",
      operation: "onboard",
      scope: "sandbox",
      signal: "policy_tier",
      value: "unknown",
      count: 1,
    });
  });

  it.each(["stale", "mismatched"] as const)(
    "does not report a stored policy receipt with %s authority (#10448)",
    (authority) => {
      const selection = {
        schemaVersion: 1,
        source: "verified_selection",
        tier: "balanced",
      } as const;
      const rows = snapshot(entry("alpha", { appliedPolicySelection: selection }));
      const stale = projectPublishedTelemetrySnapshot("restore", rows);
      const mismatched = projectPublishedTelemetrySnapshot("onboard", rows, {
        name: "alpha",
        agent: "openclaw",
        appliedPolicySelection: { ...selection, tier: "restricted" },
      });
      const events = { stale, mismatched }[authority];
      expect(
        events?.find((event) => event.event === "nemoclaw_configuration_completed"),
      ).toMatchObject({ configuration: { policyTier: null, policyTierStatus: "not_observed" } });
    },
  );

  it("does not read startup assignments when a legacy row has no registered agent (#10442)", () => {
    const events = projectPublishedTelemetrySnapshot(
      "restore",
      snapshot(
        entry("legacy", {
          agent: undefined,
          imageTag: imageRef,
          workload: managedWorkload(),
          agentVersion: "2026.9.2",
        }),
      ),
    );
    expect(
      events?.filter(
        (event) =>
          event.event === "nemoclaw_agent_runtime_observed" ||
          event.event === "nemoclaw_managed_agent_version_observed" ||
          event.event === "nemoclaw_model_observed",
      ),
    ).toEqual([]);
    expect(
      events?.find((event) => event.event === "nemoclaw_configuration_completed"),
    ).toMatchObject({
      configuration: { agentHarnessId: "unknown", agentHarnessStatus: "not_observed" },
    });
  });

  it("uses only the completed target authority to identify a legacy omitted agent (#10442)", () => {
    const rows = snapshot(
      entry("target", { agent: undefined }),
      entry("unrelated", { agent: undefined }),
    );
    const events = projectPublishedTelemetrySnapshot("onboard", rows, {
      name: "target",
      agent: "hermes",
    });
    expect(events?.filter((event) => event.event === "nemoclaw_agent_runtime_observed")).toEqual([
      {
        event: "nemoclaw_agent_runtime_observed",
        operation: "onboard",
        agent_runtime: "hermes",
        count: 1,
      },
    ]);
  });

  it.each([undefined, "private-agent-build"])(
    "maps missing or private managed versions to other with valid workload authority (#10442)",
    (agentVersion) => {
      const events = projectPublishedTelemetrySnapshot(
        "clone",
        snapshot(entry("alpha", { imageTag: imageRef, workload: managedWorkload(), agentVersion })),
      );
      expect(
        events?.filter((event) => event.event === "nemoclaw_managed_agent_version_observed"),
      ).toEqual([
        {
          event: "nemoclaw_managed_agent_version_observed",
          operation: "clone",
          agent_runtime: "openclaw",
          managed_agent_version: "other",
          count: 1,
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("private-agent-build");
    },
  );

  it("does not report managed versions for custom or contradictory workload authority (#10442)", () => {
    const events = projectPublishedTelemetrySnapshot(
      "rebuild",
      snapshot(
        entry("custom", { imageTag: "private-custom-image", agentVersion: "2026.9.2" }),
        entry("contradictory", {
          imageTag: "private-wrong-image",
          workload: managedWorkload(),
          agentVersion: "2026.9.2",
        }),
      ),
    );
    expect(
      events?.filter((event) => event.event === "nemoclaw_managed_agent_version_observed"),
    ).toEqual([]);
  });

  it("counts identical recorded primary routes twice without counting unused startup routes (#10445)", () => {
    const events = projectPublishedTelemetrySnapshot(
      "clone",
      snapshot(
        entry("alpha", {
          modelSelectionProvenance: {
            schemaVersion: 1,
            modelSource: "custom",
            apiFamily: "openai-completions",
          },
        }),
        entry("beta", {
          modelSelectionProvenance: {
            schemaVersion: 1,
            modelSource: "custom",
            apiFamily: "openai-completions",
          },
        }),
        entry("no-route", { provider: undefined, workload: managedWorkload(), imageTag: imageRef }),
      ),
    );
    expect(events?.filter((event) => event.event === "nemoclaw_model_observed")).toEqual([
      {
        event: "nemoclaw_model_observed",
        operation: "clone",
        model_source: "custom",
        known_model_key: publicModelCodes.qwen,
        modelId: "Qwen/Qwen3.6-27B-FP8",
        provider_profile: "nvidia",
        api_family: "openai-completions",
        count: 2,
      },
    ]);
  });

  it("keeps legacy route provenance unknown rather than inferring it from a public name (#10445)", () => {
    const events = projectPublishedTelemetrySnapshot("inference_set", snapshot(entry("legacy")));
    expect(events?.find((event) => event.event === "nemoclaw_model_observed")).toMatchObject({
      model_source: "unknown",
      api_family: "unknown",
      modelId: "Qwen/Qwen3.6-27B-FP8",
    });
  });

  it.each([
    { provider: "nvidia-prod", model: undefined },
    { provider: undefined, model: "Qwen/Qwen3.6-27B-FP8" },
    { provider: "nvidia-prod", model: null },
    { provider: "", model: "Qwen/Qwen3.6-27B-FP8" },
  ])("does not count an incomplete primary route as an assignment (#10445)", (overrides) => {
    const events = projectPublishedTelemetrySnapshot(
      "inference_set",
      snapshot(entry("alpha", overrides)),
    );
    expect(events?.filter((event) => event.event === "nemoclaw_model_observed")).toEqual([]);
  });

  it("deduplicates configured messaging categories per environment and excludes missing plans (#10447)", () => {
    const events = projectPublishedTelemetrySnapshot(
      "onboard",
      snapshot(
        entry("alpha", {
          messaging: {
            schemaVersion: 1,
            plan: messagingPlan("alpha", ["slack", "discord", "private-a", "private-b"]),
          },
        }),
        entry("beta", { messaging: { schemaVersion: 1, plan: messagingPlan("beta", ["slack"]) } }),
        entry("missing"),
      ),
    );
    expect(events?.filter((event) => event.event === "nemoclaw_messaging_observed")).toEqual([
      {
        event: "nemoclaw_messaging_observed",
        operation: "onboard",
        messaging_channel: "slack",
        count: 2,
      },
      {
        event: "nemoclaw_messaging_observed",
        operation: "onboard",
        messaging_channel: "discord",
        count: 1,
      },
      {
        event: "nemoclaw_messaging_observed",
        operation: "onboard",
        messaging_channel: "other",
        count: 1,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private-");
  });

  it("does not report a partial contribution from an inconsistent messaging plan (#10447)", () => {
    const events = projectPublishedTelemetrySnapshot(
      "restore",
      snapshot(
        entry("alpha", {
          messaging: {
            schemaVersion: 1,
            plan: messagingPlan("wrong-sandbox", ["slack", "discord"]),
          },
        }),
      ),
    );
    expect(events?.filter((event) => event.event === "nemoclaw_messaging_observed")).toEqual([]);
    expect(
      events?.find((event) => event.event === "nemoclaw_configuration_completed"),
    ).toMatchObject({
      configuration: { messagingStatus: "invalid", configuredMessagingChannels: [] },
    });
  });

  it("preserves an invalid messaging envelope through the real complete-registry loader (#10447)", () => {
    const committed = {
      sandboxes: {
        alpha: {
          ...entry("alpha"),
          messaging: { schemaVersion: 1, plan: { privateMalformedField: "private-value" } },
        },
      },
      defaultSandbox: "alpha",
    };
    const read = vi.spyOn(configIo, "readConfigFile").mockReturnValue(committed);
    try {
      const events = projectPublishedTelemetrySnapshot("restore", loadCompleteRegistrySnapshot());
      expect(read).toHaveBeenCalledTimes(1);
      expect(events?.[0]).toEqual({
        event: "nemoclaw_sandbox_count_observed",
        operation: "restore",
        count: 1,
      });
      expect(
        events?.find((event) => event.event === "nemoclaw_configuration_completed"),
      ).toMatchObject({
        configuration: { messagingStatus: "invalid", configuredMessagingChannels: [] },
      });
      expect(events?.filter((event) => event.event === "nemoclaw_messaging_observed")).toEqual([]);
      expect(JSON.stringify(events)).not.toContain("private-value");
    } finally {
      read.mockRestore();
    }
  });

  it("rejects a structurally invalid row through the complete-registry loader (#10442)", () => {
    const read = vi
      .spyOn(configIo, "readConfigFile")
      .mockReturnValue({ sandboxes: { alpha: entry("alpha"), broken: { name: "mismatch" } } });
    try {
      expect(() => loadCompleteRegistrySnapshot()).toThrow(
        "Cannot observe an incomplete sandbox registry",
      );
    } finally {
      read.mockRestore();
    }
  });

  it.each([
    null,
    { sandboxes: [] },
    { sandboxes: { alpha: { name: "mismatch" } } },
    {
      sandboxes: {
        alpha: entry("alpha"),
        broken: { ...entry("broken"), pendingRouteReservation: false },
      },
    },
    snapshot(
      entry("alpha"),
      entry("broken", { pendingCreateIdentity: {} as SandboxEntry["pendingCreateIdentity"] }),
    ),
    snapshot(entry("alpha"), entry("broken", { openClawConfigSyncPending: true })),
  ])("rejects an invalid complete snapshot without partial events (#10442)", (value) => {
    expect(projectPublishedTelemetrySnapshot("recovery", value)).toBeNull();
  });

  it("rejects a getter without collecting its private value (#10435)", () => {
    const getter = vi.fn(() => entry("alpha"));
    const sandboxes = {};
    Object.defineProperty(sandboxes, "alpha", { enumerable: true, get: getter });
    expect(projectPublishedTelemetrySnapshot("clone", { sandboxes })).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects an oversized complete snapshot rather than sending a truncated batch (#10442)", () => {
    const rows = Array.from({ length: MAX_TELEMETRY_BATCH_EVENTS }, (_, index) =>
      entry(`private-${index}`),
    );
    expect(projectPublishedTelemetrySnapshot("onboard", snapshot(...rows))).toBeNull();
  });

  it("removes private registry values from complete records and every aggregate (#10435)", () => {
    const events = projectPublishedTelemetrySnapshot(
      "onboard",
      snapshot(
        entry("private-sandbox", {
          agent: "private-agent",
          model: "private/model",
          provider: "private-provider",
          endpointUrl: "https://private-endpoint.invalid/v1",
          credentialEnv: "PRIVATE_API_KEY",
          imageTag: "private-image",
          fromDockerfile: "/private/Dockerfile",
        }),
      ),
    );
    expect(events).not.toBeNull();
    expect(JSON.stringify(events)).not.toContain("private");
    expect(JSON.stringify(events)).not.toContain("PRIVATE_API_KEY");
    expect(events?.find((event) => event.event === "nemoclaw_model_observed")).toMatchObject({
      model_source: "unknown",
      known_model_key: "other",
      modelId: "other",
      provider_profile: "custom",
      api_family: "unknown",
    });
  });
});
