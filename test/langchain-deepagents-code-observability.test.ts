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

function runScenario(scenario: "privacy" | "outage" | "construction" | "logging") {
  const result = spawnSync("python3", [harnessPath, scenario, modulePath], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("managed Deep Agents Code observability", () => {
  it("exports bounded content through the fixed credential-free local boundary", () => {
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
    expect(result.secret_present).toBe(true);
    expect(result.emitted).toMatchObject({
      request: {
        headers: {},
        content: {
          messages: [{ content: "NEMOCLAW-OBSERVABILITY-SECRET-SENTINEL" }],
          model: "managed-model",
        },
      },
      response: {
        content: "NEMOCLAW-OBSERVABILITY-SECRET-SENTINEL",
        error: "NEMOCLAW-OBSERVABILITY-SECRET-SENTINEL",
      },
      tool_request: { command: "NEMOCLAW-OBSERVABILITY-SECRET-SENTINEL" },
      tool_response: { stdout: "NEMOCLAW-OBSERVABILITY-SECRET-SENTINEL" },
      bounded_redaction: {
        APIKey: "<redacted>",
        APIToken: "<redacted>",
        AWS_SECRET_ACCESS_KEY: "<redacted>",
        AWSSecretAccessKey: "<redacted>",
        accessToken: "<redacted>",
        api_key: "<redacted>",
        apiKey: "<redacted>",
        auth: "<redacted>",
        authentication: "<redacted>",
        bearer: "<redacted>",
        clientSecret: "<redacted>",
        credential: "<redacted>",
        customPasswd: "<redacted>",
        DBPass: "<redacted>",
        header: "<redacted>",
        nested: { checkpoint_id: "<redacted>", command: "allowed" },
        opaque: { _omitted_type: "opaque" },
        pass: "<redacted>",
        passwd: "<redacted>",
        passCount: 4,
        passRate: 0.9,
        passThrough: "allowed",
        privateKey: "<redacted>",
        correlationMarker: "reply-correlation-marker-123",
        replyToken: "<redacted>",
        ReplyToken: "<redacted>",
        reply_token: "<redacted>",
        token: "<redacted>",
      },
      oversized_capture: {
        _truncated: true,
        _omitted_type: "opaque",
      },
      unsafe_relay_serialization: {
        fallback_string: { _omitted_type: "opaque" },
        pickle: { _omitted_type: "opaque" },
      },
      cyclic_capture: [{ _omitted_reference: "shared_or_cycle" }],
      hostile_identifier: "fallback",
      callback_records: [
        {
          operation: "push",
          name: "model",
          category: "agent",
        },
        {
          operation: "pop",
          metadata: { integration: "langgraph", "otel.status_code": "ERROR" },
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
    const resultWithBounds = result.emitted as {
      bounded_redaction: {
        oversized: string;
      };
      oversized_capture: { preview: string };
    };
    const boundedRedaction = resultWithBounds.bounded_redaction;
    expect(boundedRedaction.oversized).toMatch(/^x{8000}\.\.\.\[truncated 1000 chars\]$/);
    expect(resultWithBounds.oversized_capture.preview).toHaveLength(16_000);
    expect(
      JSON.stringify((result.emitted as { shared_capture: unknown }).shared_capture),
    ).toContain("shared_or_cycle");
    expect(
      JSON.stringify(
        (result.emitted as { unsafe_relay_serialization: unknown }).unsafe_relay_serialization,
      ),
    ).not.toContain("NEMOCLAW-UNSAFE-RELAY-FALLBACK");
    expect(JSON.stringify((result.emitted as { request: unknown }).request)).not.toMatch(
      /NEMOCLAW-DROPPED-(MODEL-SETTINGS|RESPONSE-FORMAT|TOOL-SCHEMA)/,
    );
    expect(
      JSON.stringify((result.emitted as { callback_records: unknown[] }).callback_records),
    ).not.toContain("NEMOCLAW-OBSERVABILITY-SECRET-SENTINEL");
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
      hostile: {
        same_instance: true,
        type: "_HostileDispatchError",
        message: "hostile-original:NEMOCLAW-OBSERVABILITY-SECRET-SENTINEL",
        cause_preserved: true,
        subclass_dispatches: 0,
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
      relay_observed: Array.from({ length: 6 }, () => ({
        type: "RuntimeError",
        message: "NEMOCLAW_DCODE_OPERATION_FAILED: managed operation failed (details redacted)",
        context_is_none: true,
        cause_is_none: true,
      })),
      secret_present_in_relay_errors: false,
    });
    expect(result.relay_fail_open).toEqual({
      failure_cases: {
        sync_model_before: { calls: 1, same_result: true },
        sync_model_after: { calls: 1, same_result: true },
        sync_tool_before: { calls: 1, same_result: true },
        sync_tool_after: { calls: 1, same_result: true },
        async_model_before: { calls: 1, same_result: true },
        async_model_after: { calls: 1, same_result: true },
        async_tool_before: { calls: 1, same_result: true },
        async_tool_after: { calls: 1, same_result: true },
      },
      unsafe_python_values: {
        calls: 1,
        same_result: true,
        normalized: {
          huge_negative: "<integer outside Relay JSON range>",
          huge_positive: "<integer outside Relay JSON range>",
          huge_result: "<integer outside Relay JSON range>",
          lone_surrogate: "before\ufffdafter",
          lone_surrogate_result: "before\ufffdafter",
        },
      },
    });
    expect(result.control_flow_suppression).toEqual({
      KeyboardInterrupt: true,
      SystemExit: true,
      CancelledError: true,
    });
    const transparentFallback = (type: string) => ({
      calls: 1,
      same_instance: true,
      cause_preserved: true,
      context_preserved: true,
      type,
    });
    expect(result.fallback_exception_transparency).toEqual({
      sync_model_build: transparentFallback("RuntimeError"),
      sync_model_relay: transparentFallback("KeyboardInterrupt"),
      sync_tool_build: transparentFallback("SystemExit"),
      sync_tool_relay: transparentFallback("RuntimeError"),
      async_model_build: transparentFallback("CancelledError"),
      async_model_relay: transparentFallback("RuntimeError"),
      async_tool_build: transparentFallback("RuntimeError"),
      async_tool_relay: transparentFallback("CancelledError"),
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

  it("does not log ambient OTEL values when observability initialization fails", () => {
    const result = runScenario("logging");
    const logs = String(result.logs);

    expect(result).toMatchObject({
      initialized: false,
      ambient_environment_restored: true,
      shutdown_calls: 1,
      guardrails_deregistered: 4,
    });
    expect(logs).toContain(
      "WARNING:Managed observability could not be initialized; continuing without tracing",
    );
    expect(logs).not.toMatch(
      /NEMOCLAW-OTEL-(HEADER|CERTIFICATE|CLIENT-KEY)-CANARY|RuntimeError|Traceback|registration failed/,
    );
  });
});
