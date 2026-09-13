// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { validateNemoClawConfig } from "../../config/schema";
import {
  getHermesDashboardRegistryFields,
  resolveHermesDashboardOnboardState,
} from "../../onboard/hermes-dashboard";
import {
  entry,
  snapshot,
  hermesImageRef,
  hermesProfileInput,
  managedWorkload,
  hermesSnapshot,
  verify,
  changeRetainedProfile,
} from "./export-source-test-fixture";

function hermesInterfacesSnapshot(port = 19000, internalPort = 19120, tui = true, apiPort = 8643) {
  const state = resolveHermesDashboardOnboardState({
    agentName: "hermes",
    effectivePort: port,
    env: {
      NEMOCLAW_HERMES_DASHBOARD: "1",
      NEMOCLAW_DASHBOARD_PORT: String(port),
      NEMOCLAW_HERMES_DASHBOARD_PORT: String(port),
      NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: String(internalPort),
      NEMOCLAW_HERMES_DASHBOARD_TUI: tui ? "1" : "0",
    },
  });
  return hermesSnapshot({
    ...getHermesDashboardRegistryFields(state),
    dashboardPort: port,
    hermesApiPort: apiPort,
    workload: managedWorkload(
      {
        ...hermesProfileInput(),
        dashboard: {
          agent: "hermes",
          mode: "loopback-forwarded",
          url: `http://127.0.0.1:${port}`,
          browserUrl: `http://127.0.0.1:${port}`,
          publicPort: port,
          internalPort,
          tuiEnabled: tui,
        },
      },
      hermesImageRef,
    ),
  });
}

describe("Hermes retained interface export", () => {
  it("exports dashboard, TUI and allocated API intent through the complete action (#11433)", async () => {
    const source = hermesInterfacesSnapshot();
    const exported = await exportSnapshots([source]);
    expect(exported.outcome).toEqual({ ok: true, completion: { kind: "stdout" } });
    const document = validateNemoClawConfig(YAML.parse(exported.writeStdout.mock.calls[0]![0]));
    expect(document.spec.sandboxes[0]!.agents[0]).toMatchObject({
      type: "hermes",
      interfaces: {
        dashboard: { enabled: true, port: 19000, internalPort: 19120, tui: { enabled: true } },
        api: { port: 8643 },
      },
    });
    expect(exported.read).toHaveBeenCalledTimes(2);
    expect(exported.publish).not.toHaveBeenCalled();
    expect(source.registry.hermesApiPort).toBe(8643);
  });

  it("omits managed default leaves while preserving dashboard enablement (#11433)", async () => {
    const exported = await exportSnapshots([hermesInterfacesSnapshot(18789, 19119, false, 8642)]);
    expect(exported.outcome.ok).toBe(true);
    const document = validateNemoClawConfig(YAML.parse(exported.writeStdout.mock.calls[0]![0]));
    expect(document.spec.sandboxes[0]!.agents[0]!.interfaces).toEqual({
      dashboard: { enabled: true },
    });
  });

  it.each([undefined, null, 8642])(
    "preserves canonical disabled-dashboard output with legacy API %s (#11433)",
    async (hermesApiPort) => {
      const current = await exportSnapshots([hermesSnapshot()]);
      const legacy = await exportSnapshots([hermesSnapshot({ hermesApiPort })]);
      expect(legacy.outcome.ok).toBe(true);
      expect(legacy.writeStdout.mock.calls).toEqual(current.writeStdout.mock.calls);
    },
  );

  it("exports a published nondefault API allocation with the dashboard disabled (#11433)", async () => {
    const exported = await exportSnapshots([hermesSnapshot({ hermesApiPort: 8643 })]);
    expect(exported.outcome.ok).toBe(true);
    const document = validateNemoClawConfig(YAML.parse(exported.writeStdout.mock.calls[0]![0]));
    expect(document.spec.sandboxes[0]!.agents[0]).toMatchObject({
      interfaces: { api: { port: 8643 } },
    });
  });

  it.each([
    { hermesDashboardEnabled: true },
    { hermesDashboardPort: 19000 },
    { hermesDashboardPort: false },
    { hermesDashboardInternalPort: 19120 },
    { hermesDashboardTui: true },
  ])("refuses stale settings for a disabled dashboard %j (#11433)", async (change) => {
    const source = hermesSnapshot();
    const registry = { ...source.registry };
    Object.assign(registry, change);
    const exported = await exportSnapshots([{ ...source, registry }]);
    expect(exported.outcome.ok).toBe(false);
    expect(exported.writeStdout).not.toHaveBeenCalled();
    expect(exported.publish).not.toHaveBeenCalled();
  });

  it.each([
    { hermesDashboardEnabled: false },
    { hermesDashboardEnabled: undefined },
    { dashboardPort: undefined },
    { dashboardPort: 19001 },
    { hermesDashboardPort: 19001 },
    { hermesDashboardPort: null },
    { hermesDashboardInternalPort: 19121 },
    { hermesDashboardInternalPort: undefined },
    { hermesDashboardTui: false },
    { hermesDashboardTui: undefined },
    { hermesApiPort: undefined },
    { hermesApiPort: null },
    { hermesApiPort: 8641 },
    { hermesApiPort: 8653 },
    { hermesApiPort: "8643" },
    { pendingRouteReservation: true },
    { lifecycleLiveIdentityFingerprint: "previous-sandbox" },
    { lifecycleGeneration: undefined },
    { dashboardRemoteBindPrepared: true },
  ])(
    "refuses missing, contradictory or foreign interface authority %j (#11433)",
    async (change) => {
      const source = hermesInterfacesSnapshot();
      const registry = { ...source.registry };
      Object.assign(registry, change);
      const exported = await exportSnapshots([{ ...source, registry }]);
      expect(exported.outcome).toMatchObject({ ok: false, failure: { kind: "observation" } });
      expect(exported.writeStdout).not.toHaveBeenCalled();
      expect(exported.publish).not.toHaveBeenCalled();
    },
  );

  it.each([
    "hermesApiPort",
    "hermesDashboardPort",
    "hermesDashboardInternalPort",
    "hermesDashboardEnabled",
    "hermesDashboardTui",
  ] as const)("includes %s in both complete observations (#11433)", async (key) => {
    const first = hermesInterfacesSnapshot();
    const registry = { ...first.registry };
    Object.assign(registry, { [key]: key.endsWith("Port") ? 19001 : false });
    const second = { ...first, registry };
    const exported = await exportSnapshots([first, second, first, second]);
    expect(exported.outcome).toMatchObject({
      ok: false,
      failure: { findings: [expect.objectContaining({ category: "unstable-source" })] },
    });
    expect(exported.read).toHaveBeenCalledTimes(4);
    expect(exported.writeStdout).not.toHaveBeenCalled();
  });

  it.each([
    { url: "https://user:hermes-interface-secret@dashboard.example.com" },
    { browserUrl: "https://dashboard.example.com" },
    { browserUrl: "http://127.0.0.1:19000/custom" },
    { publicPort: 18642 },
    { internalPort: 8643 },
    { internalPort: 19000 },
  ])(
    "refuses unsupported retained interfaces without exposing values %j (#11433)",
    async (change) => {
      const source = changeRetainedProfile(hermesInterfacesSnapshot(), (profile) =>
        Object.assign(profile.dashboard!, change),
      );
      const exported = await exportSnapshots([source]);
      expect(exported.outcome.ok).toBe(false);
      expect(JSON.stringify(exported.outcome)).not.toContain("hermes-interface-secret");
      expect(exported.writeStdout).not.toHaveBeenCalled();
      expect(exported.publish).not.toHaveBeenCalled();
    },
  );

  it("rejects stale Hermes interface fields on an OpenClaw source (#11433)", () => {
    expect(verify(snapshot({ registry: entry({ hermesApiPort: 8643 }) })).kind).toBe("rejected");
  });
});
