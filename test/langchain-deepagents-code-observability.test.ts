// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const modulePath = path.join(
  repoRoot,
  "agents",
  "langchain-deepagents-code",
  "nemoclaw_observability.py",
);
const harnessPath = path.join(repoRoot, "test", "fixtures", "deepagents-observability-harness.py");

function runScenario(scenario: "privacy" | "outage" | "construction") {
  const result = spawnSync("python3", [harnessPath, scenario, modulePath], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("managed Deep Agents Code observability", () => {
  it("uses a fixed headerless local exporter and strips content at the source", () => {
    const result = runScenario("privacy");

    expect(result.exact_opt_in).toEqual({
      "1": true,
      true: false,
      TRUE: false,
      " 1": false,
      "0": false,
    });
    expect(result.initialized).toBe(true);
    expect(result.initialized_again).toBe(true);
    expect(result.ambient_environment_restored).toBe(true);
    expect(result.subscriber_count).toBe(1);
    expect(result.config).toEqual({
      transport: "http_binary",
      endpoint: "http://host.openshell.internal:4318/v1/traces",
      headers: {},
      service_name: "nemoclaw-langchain-deepagents-code",
      timeout_millis: 1000,
    });
    expect(result.guardrail_priorities).toEqual({
      llm_request: 0,
      llm_response: 0,
      tool_request: 0,
      tool_response: 0,
    });
    expect(result.secret_present).toBe(false);
    expect(result.emitted).toMatchObject({
      request: { headers: {}, content: { messages: [], model: "managed-model" } },
      tool_request: {},
      tool_response: null,
      callback_records: [
        {
          operation: "push",
          name: "model",
          category: "agent",
          metadata: { integration: "langgraph" },
        },
        {
          operation: "pop",
          metadata: { "otel.status_code": "ERROR" },
        },
        {
          operation: "event",
          name: "Graph Interrupt",
          metadata: { integration: "langgraph" },
        },
        {
          operation: "event",
          name: "Graph Resume",
          metadata: { integration: "langgraph" },
        },
      ],
    });
    expect(result.middleware_distinct).toBe(true);
    expect(result.middleware_name).toBe("NemoClawObservabilityMiddleware");
    expect(result.callback_manager_boundary).toEqual({
      bound_handlers: 1,
      bound_metadata_only: true,
      copy_handlers: 1,
      copy_metadata_only: true,
      merged_handlers: 1,
      merged_metadata_only: true,
      merged_tags: ["invocation-tag"],
      merged_inheritable_tags: ["invocation-inheritable-tag"],
      merged_metadata: { invocation: "preserved" },
      merged_inheritable_metadata: { inheritable: "preserved" },
    });
    expect(result.identifier_boundaries).toEqual({
      model: `model_${"x".repeat(118)}`,
      sync_tool: `tool_${"x".repeat(119)}`,
      async_tool: `async-tool_${"x".repeat(113)}`,
      graph: `graph_${"x".repeat(118)}`,
    });
    expect(result.error_boundary).toEqual({
      control_flow: {
        same_instance: true,
        relay_observed: true,
      },
      preserved: {
        sync_model: {
          same_instance: true,
          type: "_SensitiveOperationError",
          message: "sync-model:NEMOCLAW-OBSERVABILITY-SECRET-SENTINEL",
        },
        sync_tool: {
          same_instance: true,
          type: "_SensitiveOperationError",
          message: "sync-tool:NEMOCLAW-OBSERVABILITY-SECRET-SENTINEL",
        },
        async_model: {
          same_instance: true,
          type: "_SensitiveOperationError",
          message: "async-model:NEMOCLAW-OBSERVABILITY-SECRET-SENTINEL",
        },
        async_tool: {
          same_instance: true,
          type: "_SensitiveOperationError",
          message: "async-tool:NEMOCLAW-OBSERVABILITY-SECRET-SENTINEL",
        },
      },
      relay_observed: Array.from({ length: 5 }, () => ({
        type: "RuntimeError",
        message: "NEMOCLAW_DCODE_OPERATION_FAILED: managed operation failed (details redacted)",
        context_is_none: true,
        cause_is_none: true,
      })),
      secret_present_in_relay_errors: false,
    });
    expect(result.flush_calls).toBe(1);
    expect(result.force_flush_calls).toBe(1);
    expect(result.shutdown_calls).toBe(1);
    expect(result.guardrails_deregistered).toBe(4);
  });

  it("keeps agent shutdown fail-open when the collector cannot flush", () => {
    expect(runScenario("outage")).toEqual({
      initialized: true,
      flush_calls: 1,
      force_flush_calls: 1,
      deregistered: ["nemoclaw-dcode-openinference"],
      shutdown_calls: 1,
      guardrails_deregistered: 4,
    });
  });

  it("rolls back source sanitizers when exporter construction fails", () => {
    expect(runScenario("construction")).toEqual({
      initialized: false,
      flush_calls: 0,
      force_flush_calls: 0,
      deregistered: [],
      shutdown_calls: 0,
      guardrails_deregistered: 4,
    });
  });
});
