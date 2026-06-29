// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  isExpectedMcpCurlPolicyDenial,
  restoreDnsRebindingHostsFixture,
} from "../live/mcp-bridge-sandbox.ts";

function denialResult(
  overrides: {
    exitCode?: number | null;
    stderr?: string;
    stdout?: string;
    timedOut?: boolean;
  } = {},
) {
  return {
    exitCode: overrides.exitCode ?? 0,
    stderr: overrides.stderr ?? "",
    stdout: overrides.stdout ?? "",
    timedOut: overrides.timedOut ?? false,
  };
}

describe("MCP curl policy denial classification", () => {
  it("accepts an L7 HTTP 403 denial", () => {
    expect(
      isExpectedMcpCurlPolicyDenial(denialResult({ stdout: "NEMOCLAW_MCP_CURL_HTTP_CODE=403\n" })),
    ).toBe(true);
  });

  it("accepts curl exit 56 only for a CONNECT proxy 403", () => {
    expect(
      isExpectedMcpCurlPolicyDenial(
        denialResult({
          exitCode: 56,
          stderr: "curl: (56) CONNECT tunnel failed, response 403\n",
          stdout: "NEMOCLAW_MCP_CURL_HTTP_CODE=\n",
        }),
      ),
    ).toBe(true);

    expect(
      isExpectedMcpCurlPolicyDenial(
        denialResult({ exitCode: 56, stderr: "curl: (56) Failure when receiving data" }),
      ),
    ).toBe(false);
  });

  it("rejects allowed, unrelated, and timed-out results", () => {
    expect(
      isExpectedMcpCurlPolicyDenial(denialResult({ stdout: "NEMOCLAW_MCP_CURL_HTTP_CODE=200\n" })),
    ).toBe(false);
    expect(
      isExpectedMcpCurlPolicyDenial(
        denialResult({ exitCode: 7, stderr: "curl: (7) Connection refused" }),
      ),
    ).toBe(false);
    expect(
      isExpectedMcpCurlPolicyDenial(
        denialResult({
          exitCode: 56,
          stderr: "curl: (56) CONNECT tunnel failed, response 403",
          timedOut: true,
        }),
      ),
    ).toBe(false);
  });

  it("restores the DNS fixture before MCP removal can restart the sandbox", () => {
    const source = fs.readFileSync("test/e2e-scenario/live/mcp-bridge.test.ts", "utf8");
    const denialProof = source.indexOf("expect(rebindMcp.requests).toHaveLength(0);");
    const restore = source.indexOf("await restoreDnsRebindingHostsFixture", denialProof);
    const remove = source.indexOf("const rebindRemove = await host.nemoclaw", denialProof);

    expect(denialProof).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThan(denialProof);
    expect(remove).toBeGreaterThan(restore);
  });

  it("restores host DNS strictly while treating the ephemeral sandbox as best effort", async () => {
    let restoreScript = "";
    const host = {
      command: async (_command: string, args: string[]) => {
        restoreScript = args[1] ?? "";
        return denialResult();
      },
    } as unknown as HostCliClient;

    await restoreDnsRebindingHostsFixture(host, "test-sandbox", {
      hostname: "mcp-rebind.example.test",
      hostBackupPath: "/tmp/host-backup",
      sandboxBackupPath: "/tmp/sandbox-backup",
    });

    expect(restoreScript).toContain('if ! sudo -n tee /etc/hosts < "$host_backup"');
    expect(restoreScript).toContain('if ! cmp -s "$host_backup" /etc/hosts');
    expect(restoreScript).toContain("for attempt in 1 2 3; do");
    expect(restoreScript).toContain('docker exec --user 0 -i "$container_id"');
    expect(restoreScript).toContain(
      "::warning::could not restore ephemeral sandbox /etc/hosts; cleanup will destroy the sandbox",
    );
    expect(restoreScript).toContain("failed to remove DNS rebinding hosts backups");
  });
});
