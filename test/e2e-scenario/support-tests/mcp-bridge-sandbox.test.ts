// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { testTimeout } from "../../helpers/timeouts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  isExpectedMcpCurlPolicyDenial,
  restoreDnsRebindingHostsFixture,
} from "../live/mcp-bridge-sandbox.ts";

const SUITE_OPTIONS = { timeout: testTimeout(15_000) };

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

async function captureRestoreScript(hostBackupPath: string, sandboxBackupPath: string) {
  let restoreScript = "";
  const host = {
    command: async (_command: string, args: string[]) => {
      restoreScript = args[1] ?? "";
      return denialResult();
    },
  } as unknown as HostCliClient;

  await restoreDnsRebindingHostsFixture(host, "test-sandbox", {
    hostname: "mcp-rebind.example.test",
    hostBackupPath,
    sandboxBackupPath,
  });
  return restoreScript;
}

describe("MCP curl policy denial classification", SUITE_OPTIONS, () => {
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
    const restoreScript = await captureRestoreScript("/tmp/host-backup", "/tmp/sandbox-backup");

    expect(restoreScript).toContain("set -uo pipefail");
    expect(restoreScript).not.toContain("set -euo pipefail");
    expect(restoreScript).toContain('if ! sudo -n tee /etc/hosts < "$host_backup"');
    expect(restoreScript).toContain('if ! cmp -s "$host_backup" /etc/hosts');
    expect(restoreScript).toContain("host_restore_failed=1");
    expect(restoreScript).toContain('if [ "$host_restore_failed" -ne 0 ]; then exit 1; fi');
    expect(restoreScript).toContain("for attempt in 1 2 3; do");
    expect(restoreScript).toContain('docker exec --user 0 -i "$container_id"');
    expect(restoreScript).toContain(
      "::warning::could not restore ephemeral sandbox /etc/hosts; cleanup will destroy the sandbox",
    );
    expect(restoreScript).toContain("failed to remove DNS rebinding hosts backups");
  });

  it("executes every restore outcome without an unlabeled errexit", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-restore-"));
    const binDir = path.join(tempDir, "bin");
    const hostBackupPath = path.join(tempDir, "host-backup");
    const sandboxBackupPath = path.join(tempDir, "sandbox-backup");
    const fakeHostsPath = path.join(tempDir, "hosts");
    fs.mkdirSync(binDir);
    const writeExecutable = (name: string, source: string) => {
      const target = path.join(binDir, name);
      fs.writeFileSync(target, source, { mode: 0o755 });
    };
    writeExecutable(
      "sudo",
      '#!/bin/sh\n[ "${FAKE_SUDO_STATUS:-0}" -eq 0 ] || exit "$FAKE_SUDO_STATUS"\ncat > "$FAKE_HOSTS_PATH"\n',
    );
    writeExecutable("cmp", '#!/bin/sh\nexit "${FAKE_CMP_STATUS:-0}"\n');
    writeExecutable(
      "docker",
      '#!/bin/sh\nif [ "$1" = ps ]; then echo fake-container; exit 0; fi\nif [ "$1" = exec ]; then cat >/dev/null; exit "${FAKE_DOCKER_EXEC_STATUS:-0}"; fi\nexit 64\n',
    );
    writeExecutable("sleep", "#!/bin/sh\nexit 0\n");

    try {
      const restoreScript = await captureRestoreScript(hostBackupPath, sandboxBackupPath);
      const runRestore = (extraEnv: Record<string, string> = {}) =>
        spawnSync("/bin/bash", ["-c", restoreScript], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            FAKE_HOSTS_PATH: fakeHostsPath,
            ...extraEnv,
          },
        });
      const resetBackups = () => {
        fs.writeFileSync(hostBackupPath, "original host entries\n");
        fs.writeFileSync(sandboxBackupPath, "original sandbox entries\n");
      };

      resetBackups();
      const success = runRestore();
      expect(success.status, success.stderr).toBe(0);
      expect(success.stdout).toContain("restored host /etc/hosts");
      expect(success.stdout).toContain("restored sandbox /etc/hosts");
      expect(success.stdout).toContain("removed DNS rebinding hosts backups");
      expect(fs.existsSync(hostBackupPath)).toBe(false);
      expect(fs.existsSync(sandboxBackupPath)).toBe(false);

      resetBackups();
      const hostFailure = runRestore({ FAKE_SUDO_STATUS: "1" });
      expect(hostFailure.status).toBe(1);
      expect(hostFailure.stderr).toContain("failed to restore host /etc/hosts");
      expect(fs.existsSync(hostBackupPath)).toBe(true);
      expect(fs.existsSync(sandboxBackupPath)).toBe(true);

      resetBackups();
      const sandboxFailure = runRestore({ FAKE_DOCKER_EXEC_STATUS: "1" });
      expect(sandboxFailure.status, sandboxFailure.stderr).toBe(0);
      expect(sandboxFailure.stderr).toContain(
        "::warning::could not restore ephemeral sandbox /etc/hosts; cleanup will destroy the sandbox",
      );
      expect(fs.existsSync(hostBackupPath)).toBe(false);
      expect(fs.existsSync(sandboxBackupPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
