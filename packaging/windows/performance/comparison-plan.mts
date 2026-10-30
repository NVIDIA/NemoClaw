// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import path from "node:path";

export type PinnedCommand = {
  executable: string;
  sha256: string;
  source: string;
  args: string[];
  timeoutMs: number;
  driverFiles?: { path: string; sha256: string }[];
  configurationLogMarker?: string;
};
type Variant = {
  setup: Omit<PinnedCommand, "args" | "timeoutMs">;
  launch: PinnedCommand;
  idle: PinnedCommand;
};

function validate(command: PinnedCommand | Variant["setup"]) {
  if (
    !path.win32.isAbsolute(command.executable) ||
    !/^[a-f0-9]{64}$/u.test(command.sha256) ||
    !/^[a-f0-9]{40}$/u.test(command.source)
  )
    throw new Error("Comparison commands need exact Windows executable/source identities.");
}

// This builds a reviewed command plan; it never installs, launches, or deletes.
export function comparisonPlan(input: {
  baseline: Variant;
  candidate: Variant;
  artifactDirectory: string;
  installRoot: string;
  upgradeSupported: boolean;
}) {
  if (!path.win32.isAbsolute(input.artifactDirectory) || !path.win32.isAbsolute(input.installRoot))
    throw new Error("Comparison output and installed roots must be absolute Windows paths.");
  for (const variant of [input.baseline, input.candidate]) {
    validate(variant.setup);
    validate(variant.launch);
    validate(variant.idle);
    if (
      variant.launch.source !== variant.setup.source ||
      variant.idle.source !== variant.setup.source
    )
      throw new Error("Scenario drivers must bind to the same installed source as their variant.");
  }
  const cases: Record<string, unknown>[] = [];
  const setup = (
    variant: "baseline" | "candidate",
    id: string,
    action: "install" | "uninstall" | "upgrade",
  ) => {
    const nativeAction = action === "uninstall" ? "/uninstall" : "/install";
    cases.push({
      ...input[variant].setup,
      id,
      variant,
      action,
      timeoutMs: 900_000,
      args: [
        nativeAction,
        "/quiet",
        "/norestart",
        "/log",
        path.win32.join(input.artifactDirectory, id, "setup.log"),
      ],
      fixtureStateLabel: "disposable runner; profile data preserved",
      expectInstalled: action !== "uninstall",
    });
  };
  for (const [round, order] of [
    [1, ["baseline", "candidate"]],
    [2, ["candidate", "baseline"]],
  ] as const) {
    for (const variant of order) {
      const prefix = `round${round}-${variant}`;
      setup(variant, `${prefix}-install`, "install");
      for (const sampleKind of ["process-cold", "warm", "warm-repeat", "idle"] as const) {
        const command = sampleKind === "idle" ? input[variant].idle : input[variant].launch;
        const id = `${prefix}-${sampleKind}`;
        cases.push({
          ...command,
          id,
          variant,
          action: sampleKind === "idle" ? "idle" : "launch",
          sampleKind,
          args: command.args.map((arg) =>
            arg
              .replaceAll("{{caseDirectory}}", path.win32.join(input.artifactDirectory, id))
              .replaceAll("{{sampleKind}}", sampleKind),
          ),
          fixtureStateLabel:
            sampleKind === "process-cold"
              ? "first fresh process after install; OS caches not cold"
              : "same disposable application state; fresh process",
          diagnostics: false,
          observeProcess: sampleKind === "idle",
          wpr: false,
          expectInstalled: true,
        });
      }
      cases.push({
        id: `${prefix}-inventory`,
        variant,
        action: "inventory",
        root: input.installRoot,
      });
      setup(variant, `${prefix}-uninstall`, "uninstall");
    }
  }
  if (input.upgradeSupported) {
    setup("baseline", "upgrade-baseline-install", "install");
    setup("candidate", "upgrade-candidate", "upgrade");
    setup("candidate", "upgrade-candidate-uninstall", "uninstall");
  }
  return {
    schemaVersion: 1,
    fixtureOnly: true,
    requireUninstalledStart: true,
    comparisonOrder: ["baseline", "candidate", "candidate", "baseline"],
    sameRunnerRequired: true,
    osCacheColdClaimed: false,
    instrumentationIsSeparate: true,
    driverContract:
      "finite owned scenario driver must observe its genuine endpoint and Stop; launcher return is not readiness",
    upgradeMetric: input.upgradeSupported
      ? "explicitly supported baseline-to-candidate upgrade only"
      : "unavailable: compatible upgrade identities not supplied",
    cases,
  };
}

export function summarizeComparison(summary: {
  status: string;
  cases: {
    variant: string;
    action: string;
    sampleKind?: string;
    elapsedMs?: number;
    exitCode?: number;
    timedOut?: boolean;
    instrumentation?: { mode?: string };
    wprRequested?: boolean;
    firstConfigurationLog?: { capturedMs: number } | null;
  }[];
}) {
  const groups = new Map<
    string,
    { commandCompletedMs: number[]; firstConfigurationLogMs: number[] }
  >();
  for (const row of summary.cases) {
    if (
      row.wprRequested ||
      row.exitCode !== 0 ||
      row.timedOut ||
      row.instrumentation?.mode !== "none" ||
      !Number.isFinite(row.elapsedMs)
    )
      continue;
    const key = `${row.variant}/${row.action}/${row.sampleKind ?? "unspecified"}`;
    const group = groups.get(key) ?? { commandCompletedMs: [], firstConfigurationLogMs: [] };
    group.commandCompletedMs.push(row.elapsedMs!);
    if (row.firstConfigurationLog)
      group.firstConfigurationLogMs.push(row.firstConfigurationLog.capturedMs);
    groups.set(key, group);
  }
  return {
    status: summary.status,
    allCasesCompleted: summary.status === "collected",
    groups: Object.fromEntries(groups),
    original142SecondEndpointReproduced: false,
    interpretation:
      "raw successful sample arrays only; missing markers stay missing, command completion is not UI/model readiness",
  };
}
