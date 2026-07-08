// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_DISPLAY_NAME } from "../../cli/branding";
import { B, D, G, R, RD, YW } from "../../cli/terminal-style";

export type DoctorStatus = "ok" | "warn" | "fail" | "info";
type DoctorReportStatus = Exclude<DoctorStatus, "info">;

export type DoctorCheck = {
  group: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  hint?: string;
};

export type DoctorReport = {
  schemaVersion: 1;
  sandbox: string;
  status: DoctorReportStatus;
  failed: number;
  warnings: number;
  checks: DoctorCheck[];
};

function summarizeChecks(checks: DoctorCheck[]): {
  status: DoctorReportStatus;
  failed: number;
  warned: number;
} {
  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  if (failed > 0) return { status: "fail", failed, warned };
  if (warned > 0) return { status: "warn", failed, warned };
  return { status: "ok", failed, warned };
}

export function buildDoctorReport(sandboxName: string, checks: DoctorCheck[]): DoctorReport {
  const summary = summarizeChecks(checks);
  return {
    schemaVersion: 1,
    sandbox: sandboxName,
    status: summary.status,
    failed: summary.failed,
    warnings: summary.warned,
    checks,
  };
}

function statusLabel(status: DoctorStatus): string {
  switch (status) {
    case "ok":
      return `${G}[ok]${R}`;
    case "warn":
      return `${YW}[warn]${R}`;
    case "fail":
      return `${RD}[fail]${R}`;
    case "info":
      return `${D}[info]${R}`;
  }
}

function orderedGroups(report: DoctorReport): string[] {
  const preferred = ["Host", "Gateway", "Sandbox", "Inference", "Messaging", "Local services"];
  const remaining = report.checks
    .map((check) => check.group)
    .filter((group, index, all) => !preferred.includes(group) && all.indexOf(group) === index);
  return [...preferred, ...remaining];
}

function renderCheckGroups(report: DoctorReport): void {
  for (const group of orderedGroups(report)) {
    const checks = report.checks.filter((check) => check.group === group);
    if (checks.length === 0) continue;
    console.log("");
    console.log(`  ${G}${group}:${R}`);
    for (const check of checks) {
      console.log(`    ${statusLabel(check.status)} ${check.label}: ${check.detail}`);
      if (check.hint) console.log(`         ${D}hint: ${check.hint}${R}`);
    }
  }
}

function renderSummary(report: DoctorReport): void {
  if (report.status === "ok") {
    console.log(`  Summary: ${G}healthy${R}`);
    return;
  }
  if (report.status === "warn") {
    console.log(`  Summary: ${YW}healthy with ${report.warnings} warning(s)${R}`);
    return;
  }
  console.log(
    `  Summary: ${RD}attention needed${R} (${report.failed} failed, ${report.warnings} warning(s))`,
  );
}

export function renderDoctorReport(report: DoctorReport, asJson: boolean): number {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return report.failed > 0 ? 1 : 0;
  }

  console.log("");
  console.log(`  ${B}${CLI_DISPLAY_NAME} doctor:${R} ${report.sandbox}`);
  renderCheckGroups(report);
  console.log("");
  renderSummary(report);
  console.log("");
  return report.failed > 0 ? 1 : 0;
}
