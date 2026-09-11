// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { HERMES_INTERFACE_DEFAULTS } from "../../config/model";
import type { ManagedStartupProfile } from "../../onboard/managed-startup/profile";
import type {
  ExportFinding,
  ObservedExportRegistry,
  VerifiedExportSource,
} from "./export-evidence";

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
  return { field: `spec.sandboxes[].agents[].interfaces.${leaf}`, category, diagnostic };
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
  const projected = {
    ...(port === 18_789 ? {} : { port }),
    ...(remote ? { bind: bindAddress } : {}),
  };
  return {
    findings: openClawDashboardFindings(entry, dashboard),
    ...(Object.keys(projected).length ? { interfaces: { dashboard: projected } } : {}),
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

function disabledHermesDashboardFindings(entry: ObservedExportRegistry): ExportFinding[] {
  const stale =
    [entry.hermesDashboardEnabled, entry.hermesDashboardTui].some(
      (value) => ![undefined, null, false].includes(value),
    ) ||
    [entry.hermesDashboardPort, entry.hermesDashboardInternalPort].some(
      (value) => value !== undefined && value !== null,
    );
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
    ...(dashboard.publicPort === HERMES_INTERFACE_DEFAULTS.dashboardPort
      ? {}
      : { port: dashboard.publicPort }),
    ...(dashboard.internalPort === HERMES_INTERFACE_DEFAULTS.dashboardInternalPort
      ? {}
      : { internalPort: dashboard.internalPort }),
    ...(dashboard.tuiEnabled ? { tui: { enabled: true } } : {}),
  };
}

function inspectHermesDashboard(
  entry: ObservedExportRegistry,
  dashboard: HermesDashboard,
): InterfaceInspection {
  const findings = hermesApiFindings(entry, dashboard.mode === "loopback-forwarded");
  const api =
    typeof entry.hermesApiPort === "number" &&
    entry.hermesApiPort !== HERMES_INTERFACE_DEFAULTS.apiPort
      ? { api: { port: entry.hermesApiPort } }
      : {};
  if (dashboard.mode === "disabled") {
    return {
      findings: [...findings, ...disabledHermesDashboardFindings(entry)],
      ...(Object.keys(api).length ? { interfaces: api } : {}),
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
