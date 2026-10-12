// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  openClawAgentIncompleteTurnSignal,
  openClawAgentResponseRecord,
  openClawUnframedJsonText,
  parseOpenClawJsonDocuments,
} from "../../../src/lib/openclaw/agent-json-provenance.ts";
import {
  containsToolCallOutput,
  containsToolCallStructure,
} from "../../helpers/e2e-answer-assertions.ts";

import type { ShellProbeResult } from "./shell-probe.ts";

const OPENCLAW_TEXT_KEYS = ["text", "content"] as const;
const OPENCLAW_CONTAINER_KEYS = [
  "result",
  "payloads",
  "payload",
  "messages",
  "choices",
  "message",
  "delta",
  "response",
  "data",
  "output",
  "outputs",
  "items",
  "segments",
] as const;

function responseContainsToolCallStructure(
  document: unknown,
  response: Record<string, unknown>,
): boolean {
  const { meta: _meta, ...replyFields } = response;
  if (containsToolCallStructure(replyFields)) return true;
  if (document === response || !document || typeof document !== "object") return false;
  const { result: _result, ...wrapperFields } = document as Record<string, unknown>;
  return containsToolCallStructure(wrapperFields);
}

function collectOpenClawAssistantText(
  value: unknown,
  parts: string[],
  visited: Set<unknown>,
): void {
  if (value == null || visited.has(value)) return;
  if (typeof value === "string") {
    if (value.trim()) parts.push(value);
    return;
  }
  if (typeof value !== "object") return;
  visited.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectOpenClawAssistantText(item, parts, visited));
    return;
  }

  const record = value as Record<string, unknown>;
  const role =
    typeof record.role === "string" ? record.role.replaceAll("_", "-").toLowerCase() : "";
  if (role && role !== "assistant") return;
  for (const key of OPENCLAW_TEXT_KEYS) {
    collectOpenClawAssistantText(record[key], parts, visited);
  }
  for (const key of OPENCLAW_CONTAINER_KEYS) {
    collectOpenClawAssistantText(record[key], parts, visited);
  }
}

function openClawAgentTextParts(raw: string): string[] {
  if (containsToolCallOutput(openClawUnframedJsonText(raw))) return [];
  const documents = parseOpenClawJsonDocuments(raw);
  const incomplete = openClawAgentIncompleteTurnSignal(raw);
  if (incomplete) {
    return [];
  }
  const parts: string[] = [];
  for (const document of documents) {
    const response = openClawAgentResponseRecord(document);
    if (response && Array.isArray(response.payloads)) {
      if (responseContainsToolCallStructure(document, response)) return [];
      collectOpenClawAssistantText(response.payloads, parts, new Set());
    } else if (containsToolCallStructure(document)) {
      return [];
    }
  }
  return parts;
}

export function parseOpenClawAgentText(raw: string): string {
  const reply = openClawAgentTextParts(raw)
    .map((part) => part.trim())
    .join("\n");
  return containsToolCallOutput(reply) ? "" : reply;
}

export function isExactOpenClawAgentText(raw: string, expected: string): boolean {
  const parts = openClawAgentTextParts(raw);
  return parts.length === 1 && parts[0] === expected;
}

export function nativeStateDoctorReportIsValid(
  result: Pick<ShellProbeResult, "stdout" | "exitCode" | "timedOut">,
): boolean {
  const reports = parseOpenClawJsonDocuments(result.stdout);
  const report = reports[0] as Record<string, unknown> | undefined;
  // Keep unrelated warnings in the raw report. Detector and state-write errors,
  // plus any finding on the state root or config, fail this permission check.
  return (
    reports.length === 1 &&
    result.timedOut === false &&
    (result.exitCode === 0 || result.exitCode === 1) &&
    report?.ok === (result.exitCode === 0) &&
    report?.checksRun === 1 &&
    Array.isArray(report?.findings) &&
    report.findings.every(
      (finding) =>
        finding?.checkId === "core/doctor/state-integrity" &&
        (finding.severity === "info" || finding.severity === "warning") &&
        finding.path !== "/sandbox/.openclaw" &&
        finding.path !== "/sandbox/.openclaw/openclaw.json",
    )
  );
}

export function nativeStateProcessIdentitiesAreValid(
  result: Pick<ShellProbeResult, "stdout" | "exitCode" | "timedOut">,
): boolean {
  const lines = result.stdout.trim().split(/\r?\n/u);
  const processes = lines
    .slice(1)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+([1-9]\d*)\s+(\d+)\s+(\S.*)$/u)?.slice(1) ?? []);
  const gateways = processes.filter((row) => row[4] === "openclaw-gatewa");
  const gateway = gateways[0];
  const parent = processes.find((row) => row[2] === gateway?.[3]);
  const supervisor = processes.find((row) => row[2] === "1");
  return (
    result.timedOut === false &&
    result.exitCode === 0 &&
    lines[0]?.trim().split(/\s+/u).join(" ") === "EUID EGID PID PPID COMMAND" &&
    processes.every((row) => row.length === 5) &&
    new Set(processes.map((row) => row[2])).size === processes.length &&
    gateways.length === 1 &&
    Number(gateway?.[0]) > 0 &&
    Number(gateway?.[1]) > 0 &&
    parent?.[4] === "bash" &&
    parent[3] === "1" &&
    gateway?.[0] === parent[0] &&
    gateway?.[1] === parent[1] &&
    supervisor?.[0] === "0" &&
    supervisor[1] === "0" &&
    supervisor[3] === "0"
  );
}
