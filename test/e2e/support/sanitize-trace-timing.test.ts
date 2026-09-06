// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SANITIZER = "scripts/e2e/sanitize-trace-timing.py";
const SUMMARY = "cloud-onboard-trace-timing-summary.json";

function runPython(script: string) {
  return spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function runSanitizer(source: string, output: string) {
  return spawnSync("python3", [SANITIZER, source, output], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

type SettlementTrace = {
  timeUnixNano: string;
  identityState: "failed" | "matched";
  correlation: string | null;
};

function makeTrace({
  totalDurationMs = 42.9876,
  settlement,
}: { totalDurationMs?: number; settlement?: SettlementTrace } = {}) {
  return {
    resource_spans: [
      {
        resource: { attributes: { "service.name": "nemoclaw" } },
        scope_spans: [
          {
            scope: { name: "nemoclaw.onboard", version: "1.0.0" },
            spans: [
              {
                name: "nemoclaw.onboard",
                duration_ms: 42,
                attributes: { api_key: "nvapi-should-never-appear" },
                events: [{ name: "prompt", attributes: { value: "secret prompt" } }],
              },
              {
                name: "nemoclaw.onboard.phase.gateway",
                duration_ms: 7.1234,
                attributes: { endpoint: "https://example.test/token" },
                events: settlement
                  ? [
                      {
                        name: "sandbox_create_identity_settlement",
                        time_unix_nano: settlement.timeUnixNano,
                        attributes: {
                          create_operation_state: "ready",
                          identity_state: settlement.identityState,
                          returned_identity_correlation: settlement.correlation,
                        },
                      },
                    ]
                  : [],
              },
            ],
          },
        ],
      },
    ],
    summary: {
      trace_id: "0123456789abcdef0123456789abcdef",
      generated_at: "2026-07-02T00:00:00.000Z",
      output_path: "/tmp/raw-trace.json",
      slowest_spans: [
        {
          name: "nemoclaw.onboard.phase.gateway",
          duration_ms: 7.1234,
          status: "ERROR",
        },
      ],
      total_duration_ms: totalDurationMs,
    },
  };
}

describe("sanitize trace timing", () => {
  it("extract_candidate returns only the timing allowlist from the TraceArtifact shape", () => {
    const result = runPython(String.raw`
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "sanitize_trace_timing",
    Path("scripts/e2e/sanitize-trace-timing.py"),
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
artifact = {
    "resource_spans": [{
        "resource": {"attributes": {"service.name": "nemoclaw"}},
        "scope_spans": [{
            "scope": {"name": "nemoclaw.onboard", "version": "1.0.0"},
            "spans": [
                {
                    "trace_id": "0123456789abcdef0123456789abcdef",
                    "span_id": "0000000000000001",
                    "name": "nemoclaw.onboard",
                    "kind": "INTERNAL",
                    "start_time_unix_nano": "1",
                    "duration_ms": 42,
                    "status": {"code": "OK", "message": "secret detail"},
                    "attributes": {"api_key": "nvapi-secret"},
                    "events": [{"name": "prompt", "attributes": {"value": "secret"}}],
                },
                {
                    "trace_id": "0123456789abcdef0123456789abcdef",
                    "span_id": "0000000000000002",
                    "parent_span_id": "0000000000000001",
                    "name": "nemoclaw.onboard.phase.gateway",
                    "kind": "INTERNAL",
                    "start_time_unix_nano": "2",
                    "duration_ms": 7.1234,
                    "status": {"code": "ERROR", "message": "raw error"},
                    "attributes": {"endpoint": "https://example.test/token"},
                    "events": [{
                        "name": "sandbox_create_identity_settlement",
                        "time_unix_nano": "1788724801000000000",
                        "attributes": {
                            "create_operation_state": "ready",
                            "identity_state": "matched",
                            "returned_identity_correlation": "8174fa2a5d657551",
                            "durable_sandbox_id": "alpha-sandbox-id",
                            "arbitrary": {"token": "do-not-retain"},
                        },
                    }],
                },
            ],
        }],
    }],
    "summary": {
        "trace_id": "0123456789abcdef0123456789abcdef",
        "generated_at": "2026-07-02T00:00:00.000Z",
        "total_duration_ms": 42.9876,
        "slowest_spans": [{
            "name": "nemoclaw.onboard.phase.gateway",
            "duration_ms": 7.1234,
            "status": "ERROR",
        }],
        "output_path": "/tmp/raw-trace.json",
    },
}
print(json.dumps(module.extract_candidate(artifact), sort_keys=True))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      phases: { "nemoclaw.onboard.phase.gateway": 7.123 },
      schema_version: "nemoclaw.trace_timing.v1",
      slowest_spans: [
        { duration_ms: 7.123, name: "nemoclaw.onboard.phase.gateway", status: "ERROR" },
      ],
      total_duration_ms: 42.988,
      trace_id: "0123456789abcdef0123456789abcdef",
    });
    expect(result.stdout).not.toMatch(
      /alpha-sandbox-id|api_key|arbitrary|attributes|do-not-retain|durable_sandbox_id|events|output_path|raw error|secret|token/u,
    );
  });

  it("extract_candidate rejects non-onboard and incomplete traces", () => {
    const result = runPython(String.raw`
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "sanitize_trace_timing",
    Path("scripts/e2e/sanitize-trace-timing.py"),
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
cases = [
    None,
    {"summary": {"total_duration_ms": 1}, "resource_spans": []},
    {
        "resource_spans": [{"scope_spans": [{"spans": [{"name": "nemoclaw.other"}]}]}],
        "summary": {"total_duration_ms": 1},
    },
    {
        "resource_spans": [{"scope_spans": [{"spans": [{"name": "nemoclaw.onboard"}]}]}],
        "summary": {"total_duration_ms": "not-a-number"},
    },
    {
        "resource_spans": [{"scope_spans": [{"spans": [{"name": "nemoclaw.onboard"}]}]}],
        "summary": {"total_duration_ms": 1},
    },
]
print(json.dumps([module.extract_candidate(case) for case in cases]))
`);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([null, null, null, null, null]);
  });

  it("writes trusted summaries and directories with restrictive permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-trace-sanitize-"));
    const source = join(directory, "raw.json");
    const output = join(directory, "trusted");
    try {
      writeFileSync(
        source,
        JSON.stringify(
          makeTrace({
            settlement: {
              timeUnixNano: "1788724801000000000",
              identityState: "matched",
              correlation: "8174fa2a5d657551",
            },
          }),
        ),
      );

      const result = runSanitizer(source, output);
      expect(result.status, result.stderr).toBe(0);

      const summaryPath = join(output, SUMMARY);
      expect(JSON.parse(readFileSync(summaryPath, "utf8"))).toMatchObject({
        phases: { "nemoclaw.onboard.phase.gateway": 7.123 },
        sandbox_identity_settlement: {
          create_operation_state: "ready",
          identity_state: "matched",
          returned_identity_correlation: "8174fa2a5d657551",
        },
        total_duration_ms: 42.988,
      });
      expect(statSync(output).mode & 0o777).toBe(0o700);
      expect(statSync(summaryPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps longest-trace timing while selecting the latest valid settlement event", () => {
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-trace-sanitize-order-"));
    const source = join(directory, "raw");
    const output = join(directory, "trusted");
    try {
      mkdirSync(source);
      writeFileSync(
        join(source, "earlier-longer.json"),
        JSON.stringify(
          makeTrace({
            totalDurationMs: 200,
            settlement: {
              timeUnixNano: "1788724800000000000",
              identityState: "failed",
              correlation: null,
            },
          }),
        ),
      );
      writeFileSync(
        join(source, "later-shorter.json"),
        JSON.stringify(
          makeTrace({
            totalDurationMs: 100,
            settlement: {
              timeUnixNano: "1788724801000000000",
              identityState: "matched",
              correlation: "8174fa2a5d657551",
            },
          }),
        ),
      );

      const result = runSanitizer(source, output);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(output, SUMMARY), "utf8"))).toMatchObject({
        total_duration_ms: 200,
        sandbox_identity_settlement: {
          create_operation_state: "ready",
          identity_state: "matched",
          returned_identity_correlation: "8174fa2a5d657551",
        },
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
