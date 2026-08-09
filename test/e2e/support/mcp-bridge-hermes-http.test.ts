// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import { redactString } from "../fixtures/redaction.ts";
import { ShellProbe, trustedShellCommand } from "../fixtures/shell-probe.ts";
import {
  assertAuthenticatedMcpToolCallOutcome,
  assertHermesMcpHttpResponse,
  buildHermesMcpChatProbeScript,
  HERMES_MCP_FAILURE_CAPTURE_BYTES,
  HERMES_MCP_FAILURE_PREVIEW_CHARS,
  HERMES_MCP_HTTP_STATUS_MARKER,
  HERMES_MCP_OVERSIZE_BODY_MARKER,
  HERMES_MCP_RESPONSE_FILE_BYTES,
  HERMES_MCP_RESULT_TOKEN_MARKER,
} from "../live/mcp-bridge-hermes-http.ts";

const SPAWN_TIMEOUT_MS = 5_000;
const SYSTEM_PATH = "/usr/bin:/bin";

function deterministicEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    PATH: overrides.PATH ?? SYSTEM_PATH,
    ...overrides,
  };
}

function httpResult(status: number, body: string, resultTokenState?: "present" | "missing") {
  return {
    exitCode: 0,
    signal: null,
    stdout: body,
    stderr:
      `${HERMES_MCP_HTTP_STATUS_MARKER}${status}\n` +
      (resultTokenState ? `${HERMES_MCP_RESULT_TOKEN_MARKER}${resultTokenState}\n` : ""),
  };
}

describe("Hermes MCP HTTP failure diagnostics", () => {
  it("keeps one authenticated chat attempt without a retry path", () => {
    const resultToken = "fixture-result-token";
    const script = buildHermesMcpChatProbeScript('{"messages":[]}', resultToken);
    const syntax = spawnSync("sh", ["-n"], {
      encoding: "utf8",
      input: script,
      killSignal: "SIGKILL",
      timeout: SPAWN_TIMEOUT_MS,
    });

    expect(syntax.status, syntax.stderr).toBe(0);
    expect(script.match(/\bcurl "\$@"/gu)).toHaveLength(1);
    expect(script).toContain("Authorization: Bearer ${API_SERVER_KEY}");
    expect(script).toContain(`--max-filesize ${HERMES_MCP_RESPONSE_FILE_BYTES}`);
    expect(script).toContain("/usr/bin/python3 -I -S -c");
    expect(script).not.toMatch(/\bretry\b|\bfor\b|\bwhile\b/iu);
    expect(script).not.toContain('cat "$response_file"');

    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-hermes-mcp-http-"));
    const curl = path.join(directory, "curl");
    const count = path.join(directory, "count");
    writeFileSync(
      curl,
      [
        "#!/bin/sh",
        "set -eu",
        "output=",
        "authenticated=0",
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "-o" ]; then output="$2"; shift 2; continue; fi',
        '  if [ "$1" = "-H" ] && [ "$2" = "Authorization: Bearer ${FAKE_EXPECTED_API_KEY}" ]; then authenticated=1; fi',
        "  shift",
        "done",
        '[ "$authenticated" -eq 1 ]',
        'printf "1\\n" >> "$FAKE_CURL_COUNT"',
        'if [ -n "${FAKE_CURL_BODY_FILE:-}" ]; then cp "$FAKE_CURL_BODY_FILE" "$output"; else printf "%s" "$FAKE_CURL_BODY" > "$output"; fi',
        'printf "%s" "${FAKE_CURL_STATUS:-200}"',
      ].join("\n"),
      "utf8",
    );
    chmodSync(curl, 0o755);
    try {
      const executed = spawnSync("sh", ["-c", script], {
        encoding: "utf8",
        env: deterministicEnv({
          API_SERVER_KEY: "fixture-api-key",
          FAKE_CURL_BODY: `private response contents ${resultToken}`,
          FAKE_CURL_BODY_FILE: "",
          FAKE_CURL_COUNT: count,
          FAKE_CURL_STATUS: "200",
          FAKE_EXPECTED_API_KEY: "fixture-api-key",
          PATH: `${directory}:${SYSTEM_PATH}`,
        }),
        killSignal: "SIGKILL",
        timeout: SPAWN_TIMEOUT_MS,
      });
      expect(executed.status, executed.stderr).toBe(0);
      expect(readFileSync(count, "utf8")).toBe("1\n");
      expect(executed.stdout).toBe("");
      expect(executed.stderr).toContain(`${HERMES_MCP_HTTP_STATUS_MARKER}200`);
      expect(executed.stderr).toContain(`${HERMES_MCP_RESULT_TOKEN_MARKER}present`);
      expect(executed.stderr).not.toContain("private response contents");

      writeFileSync(
        path.join(directory, "sitecustomize.py"),
        [
          "import os, sys",
          "secret = os.environ.get('API_SERVER_KEY', '')",
          "sys.stdout.write(secret)",
          "sys.stderr.write(secret)",
        ].join("\n"),
        "utf8",
      );
      const hostileKey = "fixture-api-key";
      const failed = spawnSync("sh", ["-c", script], {
        encoding: "utf8",
        env: deterministicEnv({
          API_SERVER_KEY: hostileKey,
          FAKE_CURL_BODY: "failure body without credential",
          FAKE_CURL_BODY_FILE: "",
          FAKE_CURL_COUNT: count,
          FAKE_CURL_STATUS: "500",
          FAKE_EXPECTED_API_KEY: hostileKey,
          PATH: `${directory}:${SYSTEM_PATH}`,
          PYTHONPATH: directory,
          PYTHONWARNINGS: `${hostileKey}::Warning`,
        }),
        killSignal: "SIGKILL",
        timeout: SPAWN_TIMEOUT_MS,
      });
      expect(failed.status, failed.stderr).toBe(0);
      expect(readFileSync(count, "utf8")).toBe("1\n1\n");
      expect(failed.stdout).toBe("failure body without credential");
      expect(failed.stdout).not.toContain(hostileKey);
      expect(failed.stderr).toContain(`${HERMES_MCP_HTTP_STATUS_MARKER}500`);
      expect(failed.stderr).not.toContain(HERMES_MCP_RESULT_TOKEN_MARKER);
      expect(failed.stderr).not.toContain(hostileKey);

      const unknownKey = "synthetic-credential-segment-".repeat(4);
      const boundaryStart =
        HERMES_MCP_FAILURE_CAPTURE_BYTES - Math.floor(Buffer.byteLength(unknownKey) / 2);
      const repeatedBody = `${unknownKey}${"x".repeat(
        boundaryStart - Buffer.byteLength(unknownKey),
      )}${unknownKey}tail`;
      const repeated = spawnSync("sh", ["-c", script], {
        encoding: "utf8",
        env: deterministicEnv({
          API_SERVER_KEY: unknownKey,
          FAKE_CURL_BODY: repeatedBody,
          FAKE_CURL_BODY_FILE: "",
          FAKE_CURL_COUNT: count,
          FAKE_CURL_STATUS: "500",
          FAKE_EXPECTED_API_KEY: unknownKey,
          PATH: `${directory}:${SYSTEM_PATH}`,
        }),
        killSignal: "SIGKILL",
        timeout: SPAWN_TIMEOUT_MS,
      });
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(readFileSync(count, "utf8")).toBe("1\n1\n1\n");
      expect(repeated.stdout.match(/\[REDACTED\]/gu)).toHaveLength(2);
      expect(repeated.stdout).not.toContain(unknownKey);
      expect(repeated.stdout).not.toContain(unknownKey.slice(0, 32));
      expect(repeated.stdout).not.toContain(unknownKey.slice(-32));
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("redacts repeated and arbitrary boundary values before byte-bounding binary evidence", async () => {
    const resultToken = "fixture-result-token";
    const script = buildHermesMcpChatProbeScript('{"messages":[]}', resultToken);
    const directory = mkdtempSync(path.join(tmpdir(), "nemoclaw-hermes-mcp-bytes-"));
    const curl = path.join(directory, "curl");
    const bodyFile = path.join(directory, "body.bin");
    const apiKey = `boundary-api-key-${"k".repeat(64)}`;
    const explicitValue = `private-prompt-${"p".repeat(64)}`;
    const oversizeSecret = `oversize-private-${"s".repeat(80)}`;
    writeFileSync(
      curl,
      [
        "#!/bin/sh",
        "set -eu",
        "max_size=",
        "output=",
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "--max-filesize" ]; then max_size="$2"; shift 2; continue; fi',
        '  if [ "$1" = "-o" ]; then output="$2"; shift 2; continue; fi',
        "  shift",
        "done",
        '[ -n "$max_size" ]',
        'if [ -n "${FAKE_CURL_IGNORE_MAX_SIZE:-}" ]; then',
        '  cp "$FAKE_CURL_BODY_FILE" "$output"',
        "else",
        '  body_size="$(wc -c < "$FAKE_CURL_BODY_FILE")"',
        '  if [ "$body_size" -gt "$max_size" ]; then',
        '    dd if="$FAKE_CURL_BODY_FILE" of="$output" bs=1 count="$max_size" 2>/dev/null',
        '    if [ -n "${FAKE_CURL_RESPONSE_SIZE_FILE:-}" ]; then wc -c < "$output" > "$FAKE_CURL_RESPONSE_SIZE_FILE"; fi',
        '    printf "%s" "$FAKE_CURL_STATUS"',
        "    exit 63",
        "  fi",
        '  cp "$FAKE_CURL_BODY_FILE" "$output"',
        "fi",
        'if [ -n "${FAKE_CURL_RESPONSE_SIZE_FILE:-}" ]; then wc -c < "$output" > "$FAKE_CURL_RESPONSE_SIZE_FILE"; fi',
        'printf "%s" "$FAKE_CURL_STATUS"',
      ].join("\n"),
      "utf8",
    );
    chmodSync(curl, 0o755);
    const artifacts = new ArtifactSink(path.join(directory, "artifacts"));
    const progress = startTestProgress(
      "Hermes MCP HTTP diagnostic support",
      ["run probe", "verify result"],
      { logLine: () => undefined },
    );
    try {
      await artifacts.ensureRoot();
      const probe = new ShellProbe({
        artifacts,
        progress,
        redact: (text, values) => redactString(text, values),
        signal: new AbortController().signal,
      });
      const runBody = async (
        body: Buffer,
        artifactName: string,
        envOverrides: NodeJS.ProcessEnv = {},
      ) => {
        writeFileSync(bodyFile, body);
        return probe.run(
          trustedShellCommand({
            command: "sh",
            args: ["-c", script],
            reason: "verify Hermes MCP diagnostics redact before the bounded evidence prefix",
          }),
          {
            artifactName,
            env: deterministicEnv({
              API_SERVER_KEY: apiKey,
              FAKE_CURL_BODY: "",
              FAKE_CURL_BODY_FILE: bodyFile,
              FAKE_CURL_STATUS: "500",
              PATH: `${directory}:${SYSTEM_PATH}`,
              ...envOverrides,
            }),
            postRedactionCaptureLimitBytes: HERMES_MCP_FAILURE_CAPTURE_BYTES,
            redactionValues: [apiKey, explicitValue, oversizeSecret],
            timeoutMs: SPAWN_TIMEOUT_MS,
          },
        );
      };

      const secondKeyStart =
        HERMES_MCP_FAILURE_CAPTURE_BYTES + Math.floor(Buffer.byteLength(apiKey) / 2);
      const repeatedKeyBody = Buffer.from(
        `${apiKey}${"x".repeat(secondKeyStart - Buffer.byteLength(apiKey))}${apiKey}tail`,
        "utf8",
      );
      const repeated = await runBody(repeatedKeyBody, "repeated-key-boundary");
      expect(Buffer.byteLength(repeated.stdout, "utf8")).toBeLessThanOrEqual(
        HERMES_MCP_FAILURE_CAPTURE_BYTES,
      );
      expect(repeated.stdout.match(/\[REDACTED\]/gu)).toHaveLength(2);
      expect(repeated.stdout).not.toContain(apiKey.slice(0, 32));
      expect(repeated.stdout).not.toContain(apiKey.slice(-32));
      const repeatedArtifact = readFileSync(
        artifacts.pathFor("shell/repeated-key-boundary.stdout.txt"),
      );
      expect(repeatedArtifact.length).toBeLessThanOrEqual(HERMES_MCP_FAILURE_CAPTURE_BYTES);
      expect(repeatedArtifact.includes(Buffer.from(apiKey.slice(0, 32), "utf8"))).toBe(false);

      const explicitStart =
        HERMES_MCP_FAILURE_CAPTURE_BYTES - Math.floor(Buffer.byteLength(explicitValue) / 2);
      const explicitBody = Buffer.from(`${"y".repeat(explicitStart)}${explicitValue}tail`, "utf8");
      const explicit = await runBody(explicitBody, "explicit-value-boundary");
      expect(Buffer.byteLength(explicit.stdout, "utf8")).toBeLessThanOrEqual(
        HERMES_MCP_FAILURE_CAPTURE_BYTES,
      );
      expect(explicit.stdout).toContain("[REDACTED]");
      expect(explicit.stdout).not.toContain(explicitValue.slice(0, 32));
      expect(explicit.stdout).not.toContain(explicitValue.slice(-32));
      const explicitArtifact = readFileSync(
        artifacts.pathFor("shell/explicit-value-boundary.stdout.txt"),
      );
      expect(explicitArtifact.length).toBeLessThanOrEqual(HERMES_MCP_FAILURE_CAPTURE_BYTES);
      expect(explicitArtifact.includes(Buffer.from(explicitValue.slice(0, 32), "utf8"))).toBe(
        false,
      );

      const binaryBody = Buffer.concat([
        Buffer.alloc(1_000, 0xff),
        Buffer.from("🙂".repeat(1_000), "utf8"),
        Buffer.alloc(1_000, 0x7a),
      ]);
      const binary = await runBody(binaryBody, "invalid-utf8-multibyte-boundary");
      expect(Buffer.byteLength(binary.stdout, "utf8")).toBeLessThanOrEqual(
        HERMES_MCP_FAILURE_CAPTURE_BYTES,
      );
      expect(binary.stdout.startsWith("?".repeat(1_000))).toBe(true);
      expect(binary.stdout).toContain("🙂");
      expect(binary.stdout).not.toContain("�");
      expect(binary.stderr).not.toContain(apiKey);
      expect(
        readFileSync(artifacts.pathFor("shell/invalid-utf8-multibyte-boundary.stdout.txt")).length,
      ).toBeLessThanOrEqual(HERMES_MCP_FAILURE_CAPTURE_BYTES);

      const oversizeSecretStart =
        HERMES_MCP_RESPONSE_FILE_BYTES - Math.floor(Buffer.byteLength(oversizeSecret) / 2);
      const oversizeBody = Buffer.from(
        `${"q".repeat(oversizeSecretStart)}${oversizeSecret}${"r".repeat(1_024)}`,
        "utf8",
      );
      const responseSizeFile = path.join(directory, "oversize-response-size.txt");
      const curlLimited = await runBody(oversizeBody, "curl-limited-oversize-body", {
        FAKE_CURL_RESPONSE_SIZE_FILE: responseSizeFile,
      });
      expect(curlLimited.exitCode).toBe(63);
      expect(Number(readFileSync(responseSizeFile, "utf8").trim())).toBe(
        HERMES_MCP_RESPONSE_FILE_BYTES,
      );
      expect(curlLimited.stdout).toBe("");
      expect(curlLimited.stdout).not.toContain(oversizeSecret.slice(0, 32));
      expect(curlLimited.stderr).not.toContain(oversizeSecret.slice(0, 32));
      const curlLimitedArtifact = readFileSync(
        artifacts.pathFor("shell/curl-limited-oversize-body.stdout.txt"),
      );
      expect(curlLimitedArtifact.length).toBe(0);
      expect(curlLimitedArtifact.includes(Buffer.from(oversizeSecret.slice(0, 32), "utf8"))).toBe(
        false,
      );

      const emitterLimited = await runBody(oversizeBody, "emitter-limited-oversize-body", {
        FAKE_CURL_IGNORE_MAX_SIZE: "1",
      });
      expect(emitterLimited.exitCode).toBe(0);
      expect(emitterLimited.stdout).toBe(HERMES_MCP_OVERSIZE_BODY_MARKER);
      expect(emitterLimited.stdout).not.toContain(oversizeSecret.slice(0, 32));
      const emitterLimitedArtifact = readFileSync(
        artifacts.pathFor("shell/emitter-limited-oversize-body.stdout.txt"),
      );
      expect(emitterLimitedArtifact.length).toBeLessThanOrEqual(HERMES_MCP_FAILURE_CAPTURE_BYTES);
      expect(emitterLimitedArtifact.toString("utf8")).toBe(HERMES_MCP_OVERSIZE_BODY_MARKER);
    } finally {
      progress.stop();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("keeps HTTP 500 as a strict failure with bounded redacted body evidence", () => {
    const dynamicSecret = "fixture-dynamic-secret-value";
    const requestPayload = '{"messages":[{"content":"private diagnostic prompt"}]}';
    const longTail = "x".repeat(HERMES_MCP_FAILURE_PREVIEW_CHARS * 2);
    const body = `${requestPayload}\nAuthorization: Bearer api-server-secret-value\n${dynamicSecret}\n${longTail}`;

    expect(() =>
      assertHermesMcpHttpResponse(httpResult(500, body), [dynamicSecret, requestPayload]),
    ).toThrowError(/HTTP 500; sanitized response body:/u);

    try {
      assertHermesMcpHttpResponse(httpResult(500, body), [dynamicSecret, requestPayload]);
      throw new Error("expected HTTP 500 to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(dynamicSecret);
      expect(message).not.toContain(requestPayload);
      expect(message).not.toContain("api-server-secret-value");
      expect(message).toContain("[REDACTED]");
      expect(message).toContain("[truncated]");
      expect([...message.split("sanitized response body: ")[1]!].length).toBeLessThanOrEqual(
        HERMES_MCP_FAILURE_PREVIEW_CHARS,
      );
    }
  });

  it("requires a result token and exactly one authenticated tools/call after HTTP 2xx", () => {
    const request = {
      rpcMethod: "tools/call",
      auth: "Bearer rotated-fixture-secret",
      path: "/mcp",
    };

    expect(() => assertHermesMcpHttpResponse(httpResult(200, "", "present"), [])).not.toThrow();
    expect(() => assertHermesMcpHttpResponse(httpResult(200, "", "missing"), [])).toThrowError(
      /fixture result token/u,
    );
    expect(() =>
      assertHermesMcpHttpResponse(httpResult(200, "raw response", "present"), []),
    ).toThrowError(/success path emitted response contents/u);
    expect(() =>
      assertAuthenticatedMcpToolCallOutcome({
        requests: [request],
        callsBefore: 0,
        expectedSecret: "rotated-fixture-secret",
      }),
    ).not.toThrow();
    expect(() =>
      assertAuthenticatedMcpToolCallOutcome({
        requests: [request, request],
        callsBefore: 0,
        expectedSecret: "rotated-fixture-secret",
      }),
    ).toThrowError(/exactly one tools\/call/u);
  });
});
