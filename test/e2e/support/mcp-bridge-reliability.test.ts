// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { HostCliClient } from "../fixtures/clients/host.ts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import { ShellProbe } from "../fixtures/shell-probe.ts";
import {
  isHermesRestartTransportFailure,
  MCP_BRIDGE_TEST_REDACTION_VALUES,
  restartBridgeWithoutHostSecret,
  retryAfterHermesRestartTransportFailure,
  retryHermesGatewayDraining,
} from "../live/mcp-bridge-reliability.ts";

const HTTP_STATUS_MARKER = "NEMOCLAW_HERMES_MCP_HTTP_STATUS=";

function gatewayResult(status: number, code: string) {
  return {
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify({ error: { code } }),
    stderr: `${HTTP_STATUS_MARKER}${status}\n`,
  };
}

const HERMES_BROKEN_PIPE = `  Effective egress that would be opened:
    policy 'mcp-bridge-concurrent':
      - fixture.trycloudflare.com:443 (protocol: rest, enforcement: enforce)
  Applied preset: mcp-bridge-concurrent
  Narrowing sandbox egress — removing: fixture.trycloudflare.com
  Removed preset: mcp-bridge-concurrent
\u001b[1m\u001b[32m✓\u001b[39m\u001b[0m Policy version 3 submitted (hash: abcdef0123)
\u001b[1m\u001b[32m✓\u001b[39m\u001b[0m Policy version 3 loaded (active version: 3)
  Preset not found: mcp-bridge-concurrent
\u001b[1m\u001b[32m✓\u001b[39m\u001b[0m Policy version 4 submitted (hash: 0123abcdef)
\u001b[1m\u001b[32m✓\u001b[39m\u001b[0m Policy version 4 loaded (active version: 4)
  Error:   \u00d7 code: 'Unknown error', message: "h2 protocol error: error reading a body
  \u2502 from connection", source: hyper::Error(Body, Error { kind: Io(Custom
  \u2502 { kind: BrokenPipe, error: "stream closed because of a broken pipe" }) })
  \u251c\u2500\u25b6 error reading a body from connection
  \u2570\u2500\u25b6 stream closed because of a broken pipe`;

async function readRestartFailureArtifacts(root: string): Promise<string> {
  const artifactBase = path.join(root, "shell/secret-shaped-restart-mcp-restart-provider-reuse");
  return (
    await Promise.all(
      ["stdout.txt", "stderr.txt", "result.json"].map((suffix) =>
        fs.readFile(`${artifactBase}.${suffix}`, "utf8"),
      ),
    )
  ).join("\n");
}

describe("MCP bridge transient classification", () => {
  it("redacts every MCP fixture credential from a restart-command failure artifact", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-mcp-restart-redaction-"));
    const progress = startTestProgress(
      "MCP restart redaction",
      ["run failing MCP restart", "inspect redacted failure artifacts"],
      { logLine: () => undefined },
    );
    try {
      const leakedValues = [
        ...Object.values(MCP_BRIDGE_TEST_CREDENTIALS),
        `${MCP_BRIDGE_TEST_CREDENTIALS.generationWindow}7`,
      ];
      const script = path.join(root, "nemoclaw-secret-shaped-failure");
      await fs.writeFile(
        script,
        [
          "#!/bin/sh",
          ...leakedValues.map((value) => `printf '%s\\n' '${value}' >&2`),
          "exit 23",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const artifacts = new ArtifactSink(path.join(root, "artifacts"));
      const host = new HostCliClient(
        new ShellProbe({
          artifacts,
          progress,
          redact: (text) => text,
          signal: new AbortController().signal,
        }),
        { cliPath: script },
      );

      let failure: unknown;
      try {
        await restartBridgeWithoutHostSecret(host, "sandbox", "secret-shaped-restart");
      } catch (error) {
        failure = error;
      }

      expect(MCP_BRIDGE_TEST_REDACTION_VALUES).toEqual(
        Object.values(MCP_BRIDGE_TEST_CREDENTIALS),
      );
      expect(failure).toBeInstanceOf(Error);
      progress.phase("inspect redacted failure artifacts");
      const failureMessage = failure instanceof Error ? failure.message : String(failure);
      const artifactText = await readRestartFailureArtifacts(artifacts.rootDir);
      expect(failureMessage).toContain("[REDACTED]");
      expect(artifactText).toContain("[REDACTED]");
      const persistedFailure = `${failureMessage}\n${artifactText}`;
      expect(persistedFailure).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.host);
      expect(persistedFailure).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.rotatedHost);
      expect(persistedFailure).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.rebindHost);
      expect(persistedFailure).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.compatibleEndpoint);
      expect(persistedFailure).not.toContain(MCP_BRIDGE_TEST_CREDENTIALS.generationWindow);
      expect(persistedFailure).not.toContain(
        `${MCP_BRIDGE_TEST_CREDENTIALS.generationWindow}7`,
      );
    } finally {
      progress.stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts only the Hermes managed-restart broken-pipe signature (#6692)", () => {
    expect(isHermesRestartTransportFailure("hermes-config", HERMES_BROKEN_PIPE)).toBe(true);
    expect(isHermesRestartTransportFailure("mcporter", HERMES_BROKEN_PIPE)).toBe(false);
    expect(isHermesRestartTransportFailure("deepagents-config", HERMES_BROKEN_PIPE)).toBe(false);
    expect(isHermesRestartTransportFailure("hermes-config", "h2 protocol error")).toBe(false);
    expect(isHermesRestartTransportFailure("hermes-config", "stream closed: broken pipe")).toBe(
      false,
    );
    expect(
      isHermesRestartTransportFailure(
        "hermes-config",
        HERMES_BROKEN_PIPE.replace("error reading a body from connection", "unrelated failure"),
      ),
    ).toBe(false);
    expect(
      isHermesRestartTransportFailure(
        "hermes-config",
        `unexpected diagnostic before retry evidence\n${HERMES_BROKEN_PIPE}`,
      ),
    ).toBe(false);
    expect(
      isHermesRestartTransportFailure(
        "hermes-config",
        `${HERMES_BROKEN_PIPE}\nadditional failure after transport closed`,
      ),
    ).toBe(false);
  });

  it("keeps the original duplicate rejection without retrying", async () => {
    const originalResult = { exitCode: 1 };
    const retry = vi.fn(async () => ({ exitCode: 2 }));

    await expect(
      retryAfterHermesRestartTransportFailure({
        adapter: "hermes-config",
        committedBridgeVerified: true,
        diagnostic: "server already exists",
        originalResult,
        retry,
      }),
    ).resolves.toBe(originalResult);
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries the exact Hermes restart transport failure once", async () => {
    const retryResult = { exitCode: 1 };
    const retry = vi.fn(async () => retryResult);

    await expect(
      retryAfterHermesRestartTransportFailure({
        adapter: "hermes-config",
        committedBridgeVerified: true,
        diagnostic: HERMES_BROKEN_PIPE,
        originalResult: { exitCode: 1 },
        retry,
      }),
    ).resolves.toBe(retryResult);
    expect(retry).toHaveBeenCalledOnce();
  });

  it("fails closed for an unknown rejection", async () => {
    const retry = vi.fn(async () => ({ exitCode: 1 }));

    await expect(
      retryAfterHermesRestartTransportFailure({
        adapter: "hermes-config",
        committedBridgeVerified: true,
        diagnostic: "unexpected transport error",
        originalResult: { exitCode: 1 },
        retry,
      }),
    ).rejects.toThrow("not a known Hermes restart transport failure");
    expect(retry).not.toHaveBeenCalled();
  });

  it("refuses retry before the committed bridge is verified", async () => {
    const retry = vi.fn(async () => ({ exitCode: 1 }));

    await expect(
      retryAfterHermesRestartTransportFailure({
        adapter: "hermes-config",
        committedBridgeVerified: false,
        diagnostic: HERMES_BROKEN_PIPE,
        originalResult: { exitCode: 1 },
        retry,
      }),
    ).rejects.toThrow("requires a verified committed bridge");
    expect(retry).not.toHaveBeenCalled();
  });

  it("retries the exact gateway draining response with a bounded delay", async () => {
    const passing = gatewayResult(200, "none");
    const retry = vi
      .fn<(attempt: number) => Promise<typeof passing>>()
      .mockResolvedValueOnce(gatewayResult(503, "gateway_draining"))
      .mockResolvedValueOnce(passing);
    const wait = vi.fn(async () => undefined);

    await expect(
      retryHermesGatewayDraining({
        initialResult: gatewayResult(503, "gateway_draining"),
        retry,
        wait,
      }),
    ).resolves.toBe(passing);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenNthCalledWith(1, 5_000);
    expect(wait).toHaveBeenNthCalledWith(2, 5_000);
  });

  it("stops after three gateway draining retries", async () => {
    const draining = gatewayResult(503, "gateway_draining");
    const retry = vi.fn(async () => draining);
    const wait = vi.fn(async () => undefined);

    await expect(
      retryHermesGatewayDraining({ initialResult: draining, retry, wait }),
    ).resolves.toBe(draining);
    expect(retry).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(3);
  });

  it("does not retry a different Hermes HTTP failure", async () => {
    const failed = gatewayResult(503, "other");
    const retry = vi.fn(async () => gatewayResult(200, "none"));
    const wait = vi.fn(async () => undefined);

    await expect(retryHermesGatewayDraining({ initialResult: failed, retry, wait })).resolves.toBe(
      failed,
    );
    expect(retry).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });
});
