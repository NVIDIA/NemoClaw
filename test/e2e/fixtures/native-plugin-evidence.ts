// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isObjectRecord } from "../../../src/lib/core/json-types.ts";
import { shellQuote } from "../../../src/lib/core/shell-quote.ts";
import {
  openClawFinalAgentResponse,
  parseOpenClawJsonDocuments,
  projectOpenClawAgentCompletion,
} from "../../../src/lib/openclaw/agent-json-provenance.ts";

export type NativePluginVersion = "v1" | "v2";
export const NATIVE_PLUGIN_ID = "nemoclaw-e2e-tool";
export const nativeToolName = (version: NativePluginVersion) => `nemoclaw_e2e_check_${version}`;

export function nativePluginWriteScript(version: NativePluginVersion): string {
  const toolName = nativeToolName(version);
  const packageJson = JSON.stringify({
    name: "@nemoclaw/e2e-native-tool",
    version: version === "v1" ? "1.0.0" : "2.0.0",
    type: "module",
    main: "index.js",
    files: ["index.js", "openclaw.plugin.json"],
    openclaw: { extensions: ["./index.js"] },
    peerDependencies: { openclaw: ">=2026.7.1" },
  });
  const manifest = JSON.stringify({
    id: NATIVE_PLUGIN_ID,
    name: "NemoClaw E2E Tool",
    version: version === "v1" ? "1.0.0" : "2.0.0",
    description: "Dependency-free native plugin lifecycle fixture",
    activation: { onStartup: true },
    contracts: { tools: [toolName] },
    configSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  });
  const entrypoint = `const plugin = {
  id: ${JSON.stringify(NATIVE_PLUGIN_ID)},
  name: "NemoClaw E2E Tool",
  version: ${JSON.stringify(version === "v1" ? "1.0.0" : "2.0.0")},
  description: "Dependency-free native plugin lifecycle fixture",
  register(api) {
    api.registerTool({
      name: ${JSON.stringify(toolName)},
      label: "Run Local Check",
      description: "Complete a local check without accessing files or the network.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute() {
        return { content: [{ type: "text", text: "Local check completed." }] };
      },
    });
  },
};
export default plugin;
`;
  return [
    "set -eu",
    "source_dir=/sandbox/e2e-native-tool",
    'rm -rf -- "$source_dir"',
    'mkdir -p -- "$source_dir"',
    `printf '%s' ${shellQuote(packageJson)} > "$source_dir/package.json"`,
    `printf '%s' ${shellQuote(manifest)} > "$source_dir/openclaw.plugin.json"`,
    `printf '%s' ${shellQuote(entrypoint)} > "$source_dir/index.js"`,
    'HOME=/sandbox openclaw plugins install --force --accept-capabilities "$source_dir"',
  ].join("\n");
}

/** Read the gateway envelope, never a run identifier in model or tool output. */
export function completedAgentRunId(raw: string): string {
  const documents = parseOpenClawJsonDocuments(raw);
  const final = openClawFinalAgentResponse(documents);
  const completion = projectOpenClawAgentCompletion(documents);
  const runId = final?.document.runId;
  if (
    !completion.runCompleted ||
    completion.aborted ||
    completion.errorPresent ||
    typeof runId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(runId)
  ) {
    throw new Error("Native plugin agent turn has no completed gateway run");
  }
  return runId;
}

export function nativePluginPresent(raw: string, pluginId: string): boolean {
  const documents = parseOpenClawJsonDocuments(raw);
  const document = documents.length === 1 ? documents[0] : undefined;
  if (
    !isObjectRecord(document) ||
    !Array.isArray(document.plugins) ||
    !document.plugins.every((plugin) => isObjectRecord(plugin) && typeof plugin.id === "string")
  )
    throw new Error("Native plugin inventory is invalid");
  return document.plugins.some((plugin) => isObjectRecord(plugin) && plugin.id === pluginId);
}

/** Correlate metadata-only audit records from one run; tool payloads are irrelevant. */
export function nativeToolCallOutcome(
  raw: string,
  runId: string,
  toolName: string,
): "pending" | "succeeded" | "failed" {
  const documents = parseOpenClawJsonDocuments(raw);
  const document = documents.length === 1 ? documents[0] : undefined;
  if (
    !isObjectRecord(document) ||
    !Array.isArray(document.events) ||
    document.events.length > 100 ||
    document.nextCursor !== undefined ||
    !document.events.every(isObjectRecord)
  ) {
    throw new Error("Native plugin audit page is invalid or incomplete");
  }
  const calls = new Map<string, { started: boolean; finished: boolean }>();
  for (const event of document.events) {
    if (event.runId !== runId || event.toolName !== toolName) continue;
    if (
      event.kind !== "tool_action" ||
      typeof event.toolCallId !== "string" ||
      !event.toolCallId.trim()
    ) {
      return "failed";
    }
    const call = calls.get(event.toolCallId) ?? { started: false, finished: false };
    if (event.action === "tool.action.started" && event.status === "started" && !call.started) {
      call.started = true;
    } else if (
      event.action === "tool.action.finished" &&
      event.status === "succeeded" &&
      !call.finished
    ) {
      call.finished = true;
    } else {
      return "failed";
    }
    calls.set(event.toolCallId, call);
  }
  return calls.size > 0 && [...calls.values()].every((call) => call.started && call.finished)
    ? "succeeded"
    : "pending";
}
