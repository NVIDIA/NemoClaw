// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { readOpenedRegularFile } from "./native-security.mts";

export type NativePackageAgentStatus = "qualified" | "unqualified" | "not-included";
export type NativePackageAvailability = Record<"openclaw" | "hermes", NativePackageAgentStatus>;

// This package-owned record describes selection, not runtime admission. The
// launcher still owns the sealed runtime lease and qualification requirements.
export function readNativePackageAvailability(installRoot: string): NativePackageAvailability {
  const invalid = () =>
    new Error("The installed agent availability is invalid. Run Repair from Installed apps.");
  let record;
  try {
    const text = readOpenedRegularFile(
      path.join(installRoot, "runtime-package-availability.json"),
      {
        encoding: "utf8",
        maxBytes: 16 * 1024,
        rejectLinks: true,
      },
    );
    if (text === null) throw invalid();
    record = JSON.parse(text);
  } catch {
    throw invalid();
  }
  const required = [
    "schemaVersion",
    "classification",
    "runtimeId",
    "manifestSha256",
    "sourceRevision",
    "agents",
  ];
  const optional = ["prebuiltLocalModelAvailable", "bundledLocalInferenceAvailable"];
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !required.includes(key) && !optional.includes(key)) ||
    optional.some((key) => Object.hasOwn(record, key) && typeof record[key] !== "boolean") ||
    (Object.hasOwn(record, "bundledLocalInferenceAvailable") &&
      !Object.hasOwn(record, "prebuiltLocalModelAvailable")) ||
    record.schemaVersion !== 1 ||
    record.classification !== "native-runtime-package-availability" ||
    typeof record.runtimeId !== "string" ||
    record.runtimeId.length !== 64 ||
    !/^[a-f0-9]{64}$/u.test(record.runtimeId) ||
    typeof record.manifestSha256 !== "string" ||
    record.manifestSha256.length !== 64 ||
    !/^[a-f0-9]{64}$/u.test(record.manifestSha256) ||
    typeof record.sourceRevision !== "string" ||
    record.sourceRevision.length !== 40 ||
    !/^[a-f0-9]{40}$/u.test(record.sourceRevision) ||
    !Array.isArray(record.agents) ||
    record.agents.length !== 2
  )
    throw invalid();
  const statuses = new Map<string, NativePackageAgentStatus>();
  for (const row of record.agents) {
    if (
      row === null ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).length !== 2 ||
      !Object.hasOwn(row, "agent") ||
      !Object.hasOwn(row, "status") ||
      !["openclaw", "hermes"].includes(row.agent) ||
      statuses.has(row.agent) ||
      !["qualified", "unqualified", "not-included"].includes(row.status)
    )
      throw invalid();
    statuses.set(row.agent, row.status);
  }
  return { openclaw: statuses.get("openclaw")!, hermes: statuses.get("hermes")! };
}

export function assertNativePackageIncludesAgent(installRoot: string, agent: string): void {
  if (agent !== "openclaw" && agent !== "hermes") throw new Error("Select a valid agent runtime.");
  if (readNativePackageAvailability(installRoot)[agent] === "not-included")
    throw new Error("The selected agent is not included in this installer.");
}

export function nativePackageAgentSelectable(
  availability: NativePackageAvailability,
  agent: string,
): boolean {
  if (agent !== "openclaw" && agent !== "hermes") return false;
  const status = availability[agent];
  return status === "qualified" || status === "unqualified";
}
