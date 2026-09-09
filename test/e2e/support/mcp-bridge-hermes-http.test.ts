// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { assertExitZero } from "../fixtures/clients/command.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { redactString } from "../fixtures/redaction.ts";

import {
  assertHermesMcpHttpResponse,
  buildHermesMcpChatProbeScript,
  buildHermesMcpRuntimeDiagnosticsScript,
  captureHermesMcpRestartFailure,
  HERMES_MCP_FAILURE_PREVIEW_CHARS,
  HERMES_MCP_HTTP_STATUS_MARKER,
  HERMES_MCP_RESULT_TOKEN_MARKER,
  isHermesGatewayDrainingResponse,
} from "../live/mcp-bridge-hermes-http.ts";

const TIMEOUT_MS = 5_000;
const SYSTEM_PATH = "/usr/bin:/bin";
const DIAGNOSTIC_API_KEY = "a1".repeat(32);
const DIAGNOSTIC_HOST_SECRET = "fixture-host-provider-secret";

function runRuntimeDiagnostics(
  linkGatewayLog = false,
  apiKeyAssignment = `API_SERVER_KEY='${DIAGNOSTIC_API_KEY}'`,
) {
  const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-hermes-mcp-diagnostics-"));
  const hermes = path.join(directory, "hermes");
  const executed = path.join(directory, "unexpected-execution");
  try {
    mkdirSync(path.join(hermes, "runtime"), { recursive: true });
    writeFileSync(path.join(hermes, ".env"), `${apiKeyAssignment}\nOTHER=$(touch ${executed})\n`);
    writeFileSync(
      path.join(hermes, "runtime/gateway.pid"),
      JSON.stringify({ pid: 4100, start_time: 81, token: DIAGNOSTIC_HOST_SECRET }),
    );
    writeFileSync(path.join(hermes, "runtime/gateway.lock"), DIAGNOSTIC_HOST_SECRET);
    writeFileSync(
      path.join(directory, "ps"),
      `#!/bin/sh\n[ "$*" = '-eo pid,ppid,uid,stat,comm' ] || exit 64\nprintf '%s\\n' '3000 1 1000 S nemoclaw-start' '4100 3000 1000 S python3.13'\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(directory, "stat"),
      `#!/bin/sh\n[ "$1" = '-c' ] && [ "$2" = '%a %u:%g %s %n' ] || exit 64\nprintf '600 1000:1000 32 %s\\n' "$3" "$4"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(directory, "start.log"),
      `${"x".repeat(20000)}\n[ gateway ] CRITICAL: 5 exits in 60s window\n${DIAGNOSTIC_API_KEY}\n${DIAGNOSTIC_HOST_SECRET}\n`,
    );
    const gatewayLog = path.join(directory, "gateway.log");
    linkGatewayLog
      ? symlinkSync(path.join(hermes, ".env"), gatewayLog)
      : writeFileSync(gatewayLog, `Gateway exiting with code 75: ${DIAGNOSTIC_API_KEY}\n`);
    const script = buildHermesMcpRuntimeDiagnosticsScript()
      .replaceAll("/sandbox/.hermes", hermes)
      .replaceAll("/tmp/nemoclaw-start.log", path.join(directory, "start.log"))
      .replaceAll("/tmp/gateway.log", gatewayLog)
      .replaceAll("/usr/bin/ps", path.join(directory, "ps"))
      .replaceAll("/usr/bin/stat", path.join(directory, "stat"));
    const result = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      env: { PATH: `${directory}:${SYSTEM_PATH}` },
    });
    return { ...result, executed: existsSync(executed) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function httpResult(status: number, body = "", result = "") {
  return {
    exitCode: 0,
    signal: null,
    stdout: body,
    stderr: `${HERMES_MCP_HTTP_STATUS_MARKER}${status}\n${result}`,
  };
}

describe("Hermes MCP HTTP failure diagnostics", () => {
  it("captures bounded reload evidence without credentials, environment execution, or raw process arguments", () => {
    const result = runRuntimeDiagnostics();
    const evidence = redactString(result.stdout, [DIAGNOSTIC_HOST_SECRET]);
    const records = evidence
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(result.status, result.stderr).toBe(0);
    expect(result.executed).toBe(false);
    expect(result.stdout).not.toContain(DIAGNOSTIC_API_KEY);
    expect(evidence).not.toContain(DIAGNOSTIC_HOST_SECRET);
    expect(evidence).toContain("CRITICAL: 5 exits in 60s window");
    expect(evidence).toContain("Gateway exiting with code 75");
    expect(evidence.length).toBeLessThan(4096);
    expect(records[2].runtime_metadata).toContain(
      "3000 1 1000 S nemoclaw-start\n4100 3000 1000 S python3.13",
    );
    expect(records[2].runtime_metadata).toContain("600 1000:1000 32");
    expect(evidence).not.toContain('"token"');
    expect(evidence).not.toContain("OTHER=");
  });

  it("refuses a symlinked reload log while retaining independent supervisor evidence", () => {
    const result = runRuntimeDiagnostics(true);
    const records = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(result.status, result.stderr).toBe(0);
    expect(records[1]).toEqual({ log: expect.stringContaining("gateway.log"), unavailable: true });
    expect(result.stdout).toContain("CRITICAL: 5 exits in 60s window");
    expect(result.stdout).not.toContain(DIAGNOSTIC_API_KEY);
  });

  it.each([
    ["missing", ""],
    ["empty", "API_SERVER_KEY=''"],
    ["duplicate", `API_SERVER_KEY='${DIAGNOSTIC_API_KEY}'\nAPI_SERVER_KEY=other`],
    ["multiple words", "API_SERVER_KEY='one' 'two'"],
    ["malformed", "API_SERVER_KEY='unclosed"],
    ["variable expansion", 'API_SERVER_KEY="$VAR"'],
    ["braced variable expansion", 'API_SERVER_KEY="${VAR}"'],
    ["command substitution", 'API_SERVER_KEY="$(printf hidden)"'],
    ["backtick substitution", 'API_SERVER_KEY="`printf hidden`"'],
    ["tilde expansion", "API_SERVER_KEY=~user"],
    ["shell separator", "API_SERVER_KEY=value;"],
    ["oversized", `OTHER=${"x".repeat(65536)}\nAPI_SERVER_KEY='${DIAGNOSTIC_API_KEY}'`],
  ])("withholds logs when the API key input is %s", (_label, assignment) => {
    const result = runRuntimeDiagnostics(false, assignment);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("API key redaction input unavailable");
    expect(result.stdout).not.toContain(DIAGNOSTIC_API_KEY);
    expect(result.stdout).not.toContain(DIAGNOSTIC_HOST_SECRET);
    expect(result.stdout).not.toContain("CRITICAL: 5 exits");
    expect(result.stdout).toContain("3000 1 1000 S nemoclaw-start");
    expect(result.executed).toBe(false);
  });

  it.each([
    ["hermes-config", 0],
    ["openclaw-config", 1],
    ["deepagents-config", 1],
  ])("skips restart diagnostics for %s exit %s", async (adapter, exitCode) => {
    const execShell = vi.fn<SandboxClient["execShell"]>();
    await captureHermesMcpRestartFailure({
      adapter,
      result: { ...httpResult(200), exitCode },
      sandbox: { execShell },
      sandboxName: "hermes",
      redactionValues: [],
    });
    expect(execShell).not.toHaveBeenCalled();
  });

  it("bounds one failed Hermes restart capture and preserves the original error when capture fails", async () => {
    const execShell = vi
      .fn<SandboxClient["execShell"]>()
      .mockRejectedValue(new Error(DIAGNOSTIC_HOST_SECRET));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = { exitCode: 1, stdout: "", stderr: "original managed reload failure" };

    await expect(
      captureHermesMcpRestartFailure({
        adapter: "hermes-config",
        result,
        sandbox: { execShell },
        sandboxName: "hermes",
        redactionValues: [DIAGNOSTIC_HOST_SECRET],
      }),
    ).resolves.toBeUndefined();
    expect(execShell).toHaveBeenCalledOnce();
    expect(execShell).toHaveBeenCalledWith(
      "hermes",
      expect.any(String),
      expect.objectContaining({
        artifactName: "hermes-mcp-restart-failure-diagnostics",
        redactionValues: [DIAGNOSTIC_HOST_SECRET],
        captureLimitBytes: 65536,
        timeoutMs: 15000,
      }),
    );
    expect(errorLog).toHaveBeenCalledWith("Hermes MCP restart diagnostics could not be collected.");
    expect(() => assertExitZero(result, "Hermes restart")).toThrow(
      "Hermes restart failed: original managed reload failure",
    );
  });

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
