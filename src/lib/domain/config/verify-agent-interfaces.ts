// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ManagedStartupProfile } from "../../onboard/managed-startup/profile";
import type {
  ExportFinding,
  ObservedExportRegistry,
  VerifiedExportSource,
} from "./export-evidence";
import { HERMES_INTERFACE_DEFAULTS } from "../../config/model";

type InterfaceInspection = Readonly<{
  findings: readonly ExportFinding[];
  interfaces?: VerifiedExportSource["interfaces"];
  dashboard?: ManagedStartupProfile["dashboard"];
}>;

function mismatch(
  leaf: string,
  category: ExportFinding["category"],
  diagnostic: string,
): ExportFinding {
  return { field: `spec.sandboxes[].harness.interfaces.${leaf}`, category, diagnostic };
}

type OpenClawDashboard = Extract<ManagedStartupProfile["dashboard"], { agent: "openclaw" }>;

function openClawDashboardFindings(
  entry: ObservedExportRegistry,
  dashboard: OpenClawDashboard,
): ExportFinding[] {
  const { port, bindAddress } = dashboard;
  const remote = bindAddress === "0.0.0.0";
  const legacyDefault = entry.dashboardPort === undefined && port === 18_789 && !remote;
  if (entry.dashboardPort !== port && !legacyDefault) {
    return [
      mismatch(
        "dashboard.port",
        entry.dashboardPort === undefined ? "missing-provenance" : "drifted",
        "The persisted dashboard port must match the managed startup profile.",
      ),
    ];
  }
  const prepared = entry.dashboardRemoteBindPrepared;
  if (!(remote ? prepared === true : [undefined, false].includes(prepared))) {
    return [
      mismatch(
        "dashboard.bind",
        remote ? "missing-provenance" : "drifted",
        "Dashboard remote-bind preparation must match the managed startup profile.",
      ),
    ];
  }
  return [];
}

function inspectOpenClawDashboard(
  entry: ObservedExportRegistry,
  dashboard: OpenClawDashboard,
): InterfaceInspection {
  const { port, bindAddress } = dashboard;
  const remote = bindAddress === "0.0.0.0";
  return {
    findings: openClawDashboardFindings(entry, dashboard),
    interfaces: { dashboard: { port, bind: bindAddress } },
    dashboard: {
      agent: "openclaw",
      mode: remote ? "remote" : "loopback",
      url: `http://127.0.0.1:${port}`,
      port,
      bindAddress,
      wslExposure: false,
    },
  };
}

type HermesDashboard = Extract<ManagedStartupProfile["dashboard"], { agent: "hermes" }>;
type EnabledHermesDashboard = Extract<HermesDashboard, { mode: "loopback-forwarded" }>;

const ALLOCATED_LOOPBACK_DASHBOARD_URL = /^http:\/\/127\.0\.0\.1:([1-9]\d{3,4})$/u;

function allocatedLoopbackDashboardPort(dashboard: HermesDashboard): number | null {
  const port = Number(ALLOCATED_LOOPBACK_DASHBOARD_URL.exec(dashboard.url)?.[1]);
  return port >= 1024 && port <= 65_535 ? port : null;
}

function isAllocatedLoopbackDashboard(
  entry: ObservedExportRegistry,
  dashboard: HermesDashboard,
): boolean {
  const port = allocatedLoopbackDashboardPort(dashboard);
  return (
    port !== null &&
    (entry.dashboardPort === port || (entry.dashboardPort === undefined && port === 18_789)) &&
    [undefined, dashboard.url].includes(dashboard.browserUrl)
  );
}

function hermesApiFindings(
  entry: ObservedExportRegistry,
  dashboardEnabled: boolean,
): ExportFinding[] {
  const port = entry.hermesApiPort;
  if (!dashboardEnabled && (port === undefined || port === null)) return [];
  if (typeof port === "number" && Number.isInteger(port) && port >= 8642 && port <= 8652) return [];
  return [
    mismatch(
      "api.port",
      port === undefined || port === null ? "missing-provenance" : "unsupported",
      "A valid allocated Hermes API port is required for interface export.",
    ),
  ];
}

function disabledHermesDashboardFindings(
  entry: ObservedExportRegistry,
  dashboard: HermesDashboard,
): ExportFinding[] {
  const port = allocatedLoopbackDashboardPort(dashboard);
  const stale =
    [entry.hermesDashboardEnabled, entry.hermesDashboardTui].some(
      (value) => ![undefined, null, false].includes(value),
    ) ||
    [entry.hermesDashboardPort, entry.hermesDashboardInternalPort].some(
      (value) => value !== undefined && value !== null,
    ) ||
    (entry.dashboardPort !== undefined &&
      (typeof entry.dashboardPort !== "number" || (port !== null && entry.dashboardPort !== port)));
  return stale
    ? [
        mismatch(
          "dashboard",
          "drifted",
          "The registry dashboard settings disagree with its disabled startup profile.",
        ),
      ]
    : [];
}

function hermesDashboardFindings(
  entry: ObservedExportRegistry,
  dashboard: EnabledHermesDashboard,
): ExportFinding[] {
  const findings: ExportFinding[] = [];
  const evidence = [
    ["dashboard.enabled", entry.hermesDashboardEnabled, true],
    ["dashboard.port", entry.dashboardPort, dashboard.publicPort],
    ["dashboard.port", entry.hermesDashboardPort, dashboard.publicPort],
    ["dashboard.internalPort", entry.hermesDashboardInternalPort, dashboard.internalPort],
    ["dashboard.tui.enabled", entry.hermesDashboardTui, dashboard.tuiEnabled],
  ] as const;
  for (const [leaf, recorded, expected] of evidence) {
    if (
      recorded === expected ||
      (leaf === "dashboard.tui.enabled" && recorded === undefined && !expected)
    )
      continue;
    findings.push(
      mismatch(
        leaf,
        recorded === undefined || recorded === null ? "missing-provenance" : "drifted",
        "The persisted Hermes interface settings must match the managed startup profile.",
      ),
    );
  }
  return findings;
}

function projectHermesDashboard(dashboard: EnabledHermesDashboard) {
  return {
    enabled: true as const,
    port: dashboard.publicPort,
    internalPort: dashboard.internalPort,
    tui: { enabled: dashboard.tuiEnabled },
  };
}

function inspectHermesDashboard(
  entry: ObservedExportRegistry,
  dashboard: HermesDashboard,
): InterfaceInspection {
  const findings = hermesApiFindings(entry, dashboard.mode === "loopback-forwarded");
  // v0 serves the API on its allocated port, or on its own default when none is recorded.
  const api = {
    api: {
      port:
        typeof entry.hermesApiPort === "number"
          ? entry.hermesApiPort
          : HERMES_INTERFACE_DEFAULTS.apiPort,
    },
  };
  if (dashboard.mode === "disabled") {
    return {
      findings: [...findings, ...disabledHermesDashboardFindings(entry, dashboard)],
      interfaces: { dashboard: { enabled: false as const }, ...api },
      ...(isAllocatedLoopbackDashboard(entry, dashboard) ? { dashboard } : {}),
    };
  }
  const url = `http://127.0.0.1:${dashboard.publicPort}`;
  return {
    findings: [...findings, ...hermesDashboardFindings(entry, dashboard)],
    dashboard: {
      agent: "hermes",
      mode: "loopback-forwarded",
      url,
      ...(dashboard.browserUrl === undefined ? {} : { browserUrl: url }),
      publicPort: dashboard.publicPort,
      internalPort: dashboard.internalPort,
      tuiEnabled: dashboard.tuiEnabled,
    },
    interfaces: { dashboard: projectHermesDashboard(dashboard), ...api },
  };
}

/** Compare retained intent with its published registry allocation; no listener claim is made. */
export function inspectAgentInterfaces(
  entry: ObservedExportRegistry,
  profile: ManagedStartupProfile,
): InterfaceInspection {
  switch (profile.dashboard.agent) {
    case "openclaw":
      return inspectOpenClawDashboard(entry, profile.dashboard);
    case "hermes":
      return inspectHermesDashboard(entry, profile.dashboard);
    default:
      return { findings: [] };
  }
}
