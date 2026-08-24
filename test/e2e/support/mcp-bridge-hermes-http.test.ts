// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertHermesMcpHttpResponse,
  buildHermesMcpChatProbeScript,
  HERMES_MCP_FAILURE_PREVIEW_CHARS,
  HERMES_MCP_HTTP_STATUS_MARKER,
  HERMES_MCP_RESULT_TOKEN_MARKER,
  isHermesGatewayDrainingResponse,
} from "../live/mcp-bridge-hermes-http.ts";

const TIMEOUT_MS = 5_000;
const SYSTEM_PATH = "/usr/bin:/bin";

function httpResult(status: number, body = "", result = "") {
  return {
    exitCode: 0,
    signal: null,
    stdout: body,
    stderr: `${HERMES_MCP_HTTP_STATUS_MARKER}${status}\n${result}`,
  };
}

describe("Hermes MCP HTTP failure diagnostics", () => {
  it("sends one authenticated request without retrying and redacts its API key from failure output (#8697)", () => {
    const token = "fixture-result-token";
    const script = buildHermesMcpChatProbeScript('{"messages":[]}', token);

    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-hermes-mcp-http-"));
    const bodyFile = path.join(directory, "body");
    const countFile = path.join(directory, "count");
    const curl = path.join(directory, "curl");
    writeFileSync(
      curl,
      [
        "#!/bin/sh",
        "set -eu",
        'all_args="$*"',
        "output=",
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "-o" ]; then output="$2"; shift 2; continue; fi',
        "  shift",
        "done",
        'case "$all_args" in *"Authorization: Bearer $FAKE_API_KEY"*) ;; *) exit 67 ;; esac',
        'cp "$FAKE_BODY_FILE" "$output"',
        'printf "1\\n" >> "$FAKE_COUNT_FILE"',
        'printf "%s" "$FAKE_STATUS"',
      ].join("\n"),
    );
    chmodSync(curl, 0o755);

    const apiKey = "fixture-api-key-value";
    const run = (body: string, status: string) => {
      writeFileSync(bodyFile, body);
      return spawnSync("sh", ["-c", script], {
        encoding: "utf8",
        env: {
          API_SERVER_KEY: apiKey,
          FAKE_API_KEY: apiKey,
          FAKE_BODY_FILE: bodyFile,
          FAKE_COUNT_FILE: countFile,
          FAKE_STATUS: status,
          PATH: `${directory}:${SYSTEM_PATH}`,
        },
        killSignal: "SIGKILL",
        timeout: TIMEOUT_MS,
      });
    };

    try {
      const failed = run(`failed with ${apiKey}`, "500");
      expect(failed.status, failed.stderr).toBe(0);
      expect(failed.stdout).toContain("[REDACTED]");
      expect(failed.stdout).not.toContain(apiKey);
      expect(failed.stderr).toContain(`${HERMES_MCP_HTTP_STATUS_MARKER}500`);

      expect(readFileSync(countFile, "utf8")).toBe("1\n");
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects duplicate status markers, HTTP 500, and missing result tokens (#8697)", () => {
    const secret = "fixture-diagnostic-secret";
    const longBody = `${secret}\nAuthorization: Bearer another-secret\n${"x".repeat(
      HERMES_MCP_FAILURE_PREVIEW_CHARS * 2,
    )}`;
    try {
      assertHermesMcpHttpResponse(httpResult(500, longBody), [secret]);
      throw new Error("expected the HTTP 500 response assertion to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("HTTP 500");
      expect(message).toContain("[REDACTED]");
      expect(message).toContain("[truncated]");
      expect(message).not.toContain(secret);
    }

    expect(() =>
      assertHermesMcpHttpResponse(httpResult(200, `missing ${secret}`), [secret]),
    ).toThrowError(/fixture result token.*redacted response body: missing \[REDACTED\]/u);
    expect(() =>
      assertHermesMcpHttpResponse(httpResult(200, "", `${HERMES_MCP_HTTP_STATUS_MARKER}500\n`), []),
    ).toThrowError(/exactly one HTTP status marker/u);
    expect(() =>
      assertHermesMcpHttpResponse(
        httpResult(200, "", `${HERMES_MCP_RESULT_TOKEN_MARKER}present\n`),
        [],
      ),
    ).not.toThrow();
  });

  it("classifies only the exact Hermes gateway draining response", () => {
    const draining = JSON.stringify({ error: { code: "gateway_draining" } });
    expect(isHermesGatewayDrainingResponse(httpResult(503, draining))).toBe(true);
    expect(isHermesGatewayDrainingResponse(httpResult(500, draining))).toBe(false);
    expect(isHermesGatewayDrainingResponse(httpResult(503, "not-json"))).toBe(false);
    expect(
      isHermesGatewayDrainingResponse(
        httpResult(503, JSON.stringify({ error: { code: "other" } })),
      ),
    ).toBe(false);
    expect(
      isHermesGatewayDrainingResponse({
        ...httpResult(503, draining),
        exitCode: 1,
      }),
    ).toBe(false);
  });
});
