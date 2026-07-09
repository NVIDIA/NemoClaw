// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import * as coreVersion from "../core/version";
import * as sandboxList from "../openshell-sandbox-list";
import * as sandboxVersion from "../sandbox/version";
import * as registry from "../state/registry";
import * as sandboxState from "../state/sandbox";
import { upgradeSandboxes, upgradeSandboxesDependencies } from "./upgrade-sandboxes";

export function makeRecoveryManifest(sandboxName: string) {
  const timestamp = `2026-07-01T06-50-4${sandboxName.length}-044Z`;
  return {
    version: 1,
    sandboxName,
    timestamp,
    agentType: "openclaw",
    agentVersion: "2026.5.27",
    expectedVersion: "2026.5.27",
    stateDirs: ["workspace"],
    backedUpDirs: ["workspace"],
    stateFiles: [],
    dir: "/sandbox/.openclaw",
    backupPath: `/tmp/rebuild-backups/${sandboxName}/${timestamp}`,
    blueprintDigest: null,
    policyPresets: [],
    customPolicies: [],
    snapshotVersion: 1,
  };
}

export function createRecoveryHarness(
  names: string[],
  options: {
    gatewayNames?: Record<string, string>;
    gatewayPort?: number;
    liveOutput?: string;
    latestBackup?: ReturnType<typeof makeRecoveryManifest> | null;
    registryOverrides?: Record<
      string,
      Partial<{
        agent: "openclaw" | "hermes" | "langchain-deepagents-code" | null;
        agentVersion: string | null;
        nemoclawVersion: string | null;
        fromDockerfile: string | null;
      }>
    >;
    confirmedLegacyManagedNames?: string[] | string;
    staleNames?: string[];
    useRealManagedEvidence?: boolean;
  } = {},
) {
  vi.stubEnv("NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE", "1");
  vi.stubEnv(
    "NEMOCLAW_CONFIRMED_LEGACY_MANAGED_SANDBOXES",
    typeof options.confirmedLegacyManagedNames === "string"
      ? options.confirmedLegacyManagedNames
      : JSON.stringify(options.confirmedLegacyManagedNames ?? []),
  );

  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(upgradeSandboxesDependencies, "getGatewayPort").mockReturnValue(
    options.gatewayPort ?? 8080,
  );
  vi.spyOn(coreVersion, "getVersion").mockReturnValue("0.0.71");
  const liveListSpy = vi
    .spyOn(sandboxList, "captureSandboxListWithGatewayPreflightOrExit")
    .mockResolvedValue({
      status: 0,
      output: options.liveOutput ?? names.map((name) => `${name} Error`).join("\n"),
    });
  vi.spyOn(registry, "listSandboxes").mockReturnValue({
    defaultSandbox: null,
    sandboxes: names.map((name) => ({
      name,
      agent: null,
      agentVersion: "2026.5.27",
      gatewayName: options.gatewayNames?.[name],
      gatewayPort: options.gatewayPort,
      nemoclawVersion: "0.0.71",
      ...options.registryOverrides?.[name],
    })),
  });
  vi.spyOn(sandboxVersion, "checkAgentVersion").mockImplementation((...args: unknown[]) => {
    const name = String(args[0]);
    return {
      sandboxVersion: options.staleNames?.includes(name) === true ? "2026.5.26" : "2026.5.27",
      expectedVersion: "2026.5.27",
      isStale: options.staleNames?.includes(name) === true,
      verificationFailed: false,
      detectionMethod: "registry",
    };
  });
  const latestBackupSpy = vi
    .spyOn(sandboxState, "getLatestBackup")
    .mockImplementation((...args: unknown[]) =>
      options.latestBackup === undefined
        ? makeRecoveryManifest(String(args[0]))
        : options.latestBackup,
    );
  vi.spyOn(sandboxState, "validateRebuildRecoveryManifest").mockImplementation(
    (...args: unknown[]) => ({
      ok: true as const,
      manifest: args[2] as ReturnType<typeof makeRecoveryManifest>,
    }),
  );
  const managedEvidenceSpy = options.useRealManagedEvidence
    ? vi.spyOn(sandboxState, "hasPositiveManagedImageEvidence")
    : vi.spyOn(sandboxState, "hasPositiveManagedImageEvidence").mockReturnValue(true);
  const rebuildSpy = vi
    .spyOn(upgradeSandboxesDependencies, "rebuildSandbox")
    .mockResolvedValue(undefined);

  return { upgradeSandboxes, rebuildSpy, latestBackupSpy, managedEvidenceSpy, liveListSpy };
}
