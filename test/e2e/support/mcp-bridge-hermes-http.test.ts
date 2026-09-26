// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertHermesMcpHttpResponse,
  buildHermesMcpChatProbeScript,
  captureHermesMcpLifecycleFailure,
  HERMES_MCP_FAILURE_PREVIEW_CHARS,
  HERMES_MCP_HTTP_STATUS_MARKER,
  HERMES_MCP_RESULT_TOKEN_MARKER,
  isHermesGatewayDrainingResponse,
} from "../live/mcp-bridge-hermes-http.ts";

const TIMEOUT_MS = 5_000;
const SYSTEM_PATH = "/usr/bin:/bin";
const CONTAINER_ID = "a".repeat(64);

beforeEach(() => vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "docker"));
afterEach(() => vi.unstubAllEnvs());

function httpResult(status: number, body = "", result = "") {
  return {
    exitCode: 0,
    signal: null,
    stdout: body,
    stderr: `${HERMES_MCP_HTTP_STATUS_MARKER}${status}\n${result}`,
  };
}

describe("Hermes MCP HTTP failure diagnostics", () => {
  it.each(["restart", "remove"] as const)(
    "captures bounded supervisor logs after %s failure without requiring sandbox exec",
    async (operation) => {
      const command = vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0 })
        .mockResolvedValueOnce({ exitCode: 0, stdout: `${CONTAINER_ID}\n` })
        .mockResolvedValue({ exitCode: 0 });
      const host = { command, openshellCommandPath: "/reviewed/openshell" };
      await captureHermesMcpLifecycleFailure(
        host,
        { exitCode: 1, timedOut: false },
        {
          operation,
          agent: "hermes",
          sandboxName: "owned-hermes",
          redactionValues: ["fixture-secret"],
        },
      );
      expect(command).toHaveBeenNthCalledWith(
        1,
        "/reviewed/openshell",
        ["logs", "owned-hermes", "-n", "200", "--source", "all", "--since", "2m"],
        expect.objectContaining({
          artifactName: `hermes-mcp-${operation}-failure-supervisor-logs`,
          captureLimitBytes: 32_768,
          timeoutMs: 30_000,
          redactionValues: ["fixture-secret"],
        }),
      );
      expect(command).toHaveBeenCalledWith(
        "docker",
        ["logs", "--tail", "200", "--since", "3m", CONTAINER_ID],
        expect.objectContaining({
          artifactName: `hermes-mcp-${operation}-failure-container-logs`,
          captureLimitBytes: 32_768,
          timeoutMs: 30_000,
          redactionValues: ["fixture-secret"],
        }),
      );
      expect(command).toHaveBeenCalledWith(
        "docker",
        ["inspect", "--format", expect.stringContaining(".State.OOMKilled"), CONTAINER_ID],
        expect.objectContaining({
          artifactName: `hermes-mcp-${operation}-failure-container-state`,
        }),
      );
      expect(command).toHaveBeenCalledTimes(4);
    },
  );

  it("skips successful restarts and tolerates diagnostic failure without retrying", async () => {
    const command = vi.fn().mockRejectedValue(new Error("log acquisition unavailable"));
    const host = { command, openshellCommandPath: "/reviewed/openshell" };
    const options = {
      agent: "hermes",
      sandboxName: "owned-hermes",
      redactionValues: [],
      operation: "restart" as const,
    };
    await captureHermesMcpLifecycleFailure(host, { exitCode: 0, timedOut: false }, options);
    expect(command).not.toHaveBeenCalled();
    await expect(
      captureHermesMcpLifecycleFailure(host, { exitCode: null, timedOut: true }, options),
    ).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledTimes(2);
  });

  it.each(["", "not-a-container", `${CONTAINER_ID}\n${"b".repeat(64)}`])(
    "does not read container logs when resource identity is missing, invalid, or ambiguous: %j",
    async (stdout) => {
      const command = vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0 })
        .mockResolvedValueOnce({ exitCode: 0, stdout });
      await captureHermesMcpLifecycleFailure(
        { command, openshellCommandPath: "/reviewed/openshell" },
        { exitCode: 1, timedOut: false },
        { agent: "hermes", sandboxName: "owned-hermes", redactionValues: [], operation: "restart" },
      );
      expect(command).toHaveBeenCalledTimes(2);
      expect(command.mock.calls[1]?.[1]).toEqual([
        "container",
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        "label=openshell.ai/sandbox-name=owned-hermes",
        "--format",
        "{{.ID}}",
      ]);
    },
  );

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
