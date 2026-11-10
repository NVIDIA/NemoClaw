// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { shellQuote } from "../../../src/lib/core/shell-quote.ts";

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

// Native tool evidence for the pinned OpenClaw 2026.10.5 SQLite transcript.
export interface NativePluginExpectation {
  tool: string;
  plugin: string;
  args: Record<string, string | boolean>;
  details: Record<string, string | boolean>;
}

/** Read actual paired tool results, never an assistant's claimed fixture response. */
export function nativePluginResultMatches(
  session: unknown[],
  expected: NativePluginExpectation,
): boolean {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const message = (value: unknown): Record<string, unknown> | undefined => {
    const root = record(value);
    return record(root?.message ?? root);
  };
  const fieldsMatch = (value: unknown, fields: Record<string, string | boolean>): boolean => {
    const object = record(value);
    return object !== undefined && Object.entries(fields).every(([key, v]) => object[key] === v);
  };
  const calls = new Map<string, "direct" | "wrapper">();
  const qualifiedTool = `openclaw:${expected.plugin}:${expected.tool}`;
  const payloadMatches = (value: unknown): boolean => {
    const payload = record(value);
    const details = record(payload?.details);
    if (details?.persistedDetailsTruncated !== true && fieldsMatch(details, expected.details))
      return true;
    if (!Array.isArray(payload?.content)) return false;
    return payload.content.some((value) => {
      const block = record(value);
      if (block?.type !== "text" || typeof block.text !== "string") return false;
      try {
        return fieldsMatch(JSON.parse(block.text), expected.details);
      } catch {
        return false;
      }
    });
  };
  for (const value of session) {
    const msg = message(value);
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      for (const value of msg.content) {
        const call = record(value);
        if (call?.type !== "toolCall" || typeof call.id !== "string") continue;
        if (call.name === expected.tool && fieldsMatch(call.arguments, expected.args)) {
          calls.set(call.id, "direct");
        }
        const args = record(call.arguments);
        if (
          call.name === "tool_call" &&
          (args?.id === expected.tool || args?.id === qualifiedTool) &&
          fieldsMatch(args.args, expected.args)
        )
          calls.set(call.id, "wrapper");
      }
    }
    if (msg?.role !== "toolResult" || typeof msg.toolCallId !== "string" || msg.isError === true)
      continue;
    const kind = calls.get(msg.toolCallId);
    if (kind === "direct" && msg.toolName === expected.tool && payloadMatches(msg)) return true;
    if (kind !== "wrapper" || msg.toolName !== "tool_call") continue;
    const envelope = record(msg.details);
    const tool = record(envelope?.tool);
    if (
      tool?.name === expected.tool &&
      tool.id === qualifiedTool &&
      envelope?.persistedDetailsTruncated !== true &&
      payloadMatches(envelope?.result)
    )
      return true;
  }
  return false;
}

export function nativePluginInvocationPrompt(expected: NativePluginExpectation): string {
  return `Run the local fixture tool ${expected.tool} exactly once with arguments ${JSON.stringify(expected.args)}. After the tool succeeds, reply DONE. Do not call other tools or read files or session history.`;
}

export const NATIVE_PLUGIN_RESULT_MARKER = "__NEMOCLAW_NATIVE_PLUGIN_RESULT__=";

/** Run one admitted turn and reduce only its native tool evidence inside the sandbox. */
export function buildNativePluginInvocationScript(
  expected: NativePluginExpectation,
  timeoutSeconds = 30,
): string {
  const session = `e2e-native-plugin-${randomUUID()}`;
  // This fresh session has a known owner; keep native routing explicit.
  const sessionKey = `agent:main:explicit:${session}`;
  const prompt = nativePluginInvocationPrompt(expected);
  const reduce = [
    `const matches = ${nativePluginResultMatches.toString()}`,
    `const sessionId = ${JSON.stringify(session)}`,
    'const databasePath = "/sandbox/.openclaw/agents/main/agent/openclaw-agent.sqlite"',
    "let session",
    'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false, timeout: 2000 }); try { db.exec("PRAGMA query_only = ON"); session = db.prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq").all(sessionId).map(row => JSON.parse(row.event_json)); } finally { db.close(); }',
    `const matched = matches(session, ${JSON.stringify(expected)})`,
    `process.stdout.write(${JSON.stringify(NATIVE_PLUGIN_RESULT_MARKER)} + JSON.stringify({ matched }) + "\\n")`,
  ].join("; ");
  return [
    "set -eu",
    ". /tmp/nemoclaw-proxy-env.sh",
    `HOME=/sandbox openclaw agent --agent main --json --thinking off --timeout ${String(timeoutSeconds)} --session-id ${shellQuote(session)} --session-key ${shellQuote(sessionKey)} -m ${shellQuote(prompt)}`,
    `node -e ${shellQuote(reduce)}`,
  ].join("\n");
}

export function nativePluginInvocationSucceeded(stdout: string): boolean {
  const line = stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(NATIVE_PLUGIN_RESULT_MARKER))
    .at(-1);
  if (!line) return false;
  try {
    return (
      (JSON.parse(line.slice(NATIVE_PLUGIN_RESULT_MARKER.length)) as { matched?: unknown })
        .matched === true
    );
  } catch {
    return false;
  }
}
