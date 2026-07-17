// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { testTimeout } from "../../helpers/timeouts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  buildMcpDnsRebindingProbeScript,
  hostAddressForSandbox,
  hostPrivateAddressForSandbox,
  isExpectedMcpCurlPolicyDenial,
  restoreDnsRebindingHostsFixture,
} from "../live/mcp-bridge-sandbox.ts";
import {
  buildRawOpenShellAllowedIpsRebindingPolicy,
  buildRawOpenShellAllowedIpsRebindingProbeScript,
  parseRawOpenShellAllowedIpsRebindingEndpoint,
  RAW_OPENSHELL_REBIND_HOSTNAME,
  RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER,
  RAW_OPENSHELL_REBIND_PINNED_IP,
  RAW_OPENSHELL_REBIND_POLICY_KEY,
} from "../live/openshell-allowed-ips-rebinding.ts";

const SUITE_OPTIONS = { timeout: testTimeout(15_000) };
const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

function fakeCurlPath(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-raw-rebind-"));
  tempDirs.push(tempDir);
  const curl = path.join(tempDir, "curl");
  fs.writeFileSync(
    curl,
    '#!/bin/sh\nprintf %s "${FAKE_HTTP_STATUS:-000}"\nexit "${FAKE_CURL_RC:-0}"\n',
    { mode: 0o755 },
  );
  return tempDir;
}

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
  it("separates the managed endpoint alias from the concrete rebinding address", async () => {
    let probeScript = "";
    const host = {
      command: async (_command: string, args: string[]) => {
        probeScript = args[1] ?? "";
        return { ...denialResult(), stdout: "10.20.30.40\n" };
      },
    } as unknown as HostCliClient;

    await expect(hostAddressForSandbox(host)).resolves.toBe("host.openshell.internal");
    await expect(hostPrivateAddressForSandbox(host)).resolves.toBe("10.20.30.40");
    expect(probeScript).toContain("ip route get 1.1.1.1");
  });

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

  it("runs the rebinding request beneath each adapter runtime identity", () => {
    const runtimes = {
      mcporter: "nemoclaw-start node -e",
      "hermes-config": "/opt/hermes/.venv/bin/python -c",
      "deepagents-config": "/opt/venv/bin/python3 -c",
    } as const;

    for (const [adapter, runtime] of Object.entries(runtimes)) {
      const script = buildMcpDnsRebindingProbeScript(
        adapter as keyof typeof runtimes,
        "https://mcp-rebind.example.test:31337/mcp",
        "REBIND_MCP_SECRET",
      );
      expect(script, adapter).toContain(runtime);
      expect(script, adapter).toMatch(/spawnSync|subprocess\.run/);
      expect(script, adapter).toContain("'curl'");
      expect(script, adapter).toContain("NEMOCLAW_MCP_CURL_HTTP_CODE=%{http_code}");
      expect(script, adapter).toContain(
        "authorization: Bearer openshell:resolve:env:REBIND_MCP_SECRET",
      );
      expect(script, adapter).not.toContain("fake-rebind-mcp-secret-value");
      const syntax = spawnSync("/bin/bash", ["-n"], { input: script, encoding: "utf8" });
      expect(syntax.status, `${adapter}: ${syntax.stderr}`).toBe(0);
    }
  });

  it("pins the resolve-validate-connect source contract to OpenShell v0.0.85", () => {
    const commit = "3dee5570a46076a57a3b056f35f35ebc0861ac85";
    const sourcePath = "crates/openshell-supervisor-network/src/proxy.rs";
    const citations = [
      `${sourcePath}:2648-2674`,
      `${sourcePath}:2699-2739`,
      `${sourcePath}:2794-2803`,
      `${sourcePath}:1079-1081`,
      `${sourcePath}:4093-4100`,
      `${sourcePath}:4340-4342`,
    ];

    for (const docsPath of [
      "docs/deployment/set-up-mcp-bridge.mdx",
      "docs/security/openshell-0.0.85-migration-review.md",
    ]) {
      const docs = fs.readFileSync(docsPath, "utf8");
      expect(docs, docsPath).toContain(commit);
      for (const citation of citations) expect(docs, docsPath).toContain(citation);
    }
  });

  it("adds one raw MCP policy with an exact public IP pin and no adapter identity", () => {
    const rendered = buildRawOpenShellAllowedIpsRebindingPolicy(
      `version: 1
filesystem_policy:
  include_workdir: true
network_policies:
  existing:
    name: existing
    endpoints: []
    binaries: []
`,
      31337,
    );
    const parsed = YAML.parse(rendered) as {
      network_policies: Record<
        string,
        {
          binaries: Array<{ path: string }>;
          endpoints: Array<Record<string, unknown>>;
        }
      >;
    };

    expect(parsed.network_policies.existing).toBeDefined();
    const raw = parsed.network_policies[RAW_OPENSHELL_REBIND_POLICY_KEY];
    expect(raw.binaries).toEqual([{ path: "/**" }]);
    expect(raw.endpoints).toEqual([
      expect.objectContaining({
        allowed_ips: [RAW_OPENSHELL_REBIND_PINNED_IP],
        host: RAW_OPENSHELL_REBIND_HOSTNAME,
        path: "/mcp",
        port: 31337,
        protocol: "mcp",
        rules: [{ allow: { method: "tools/list" } }],
      }),
    ]);
  });

  it("reads the effective raw policy semantically when OpenShell quotes allowed IPs", () => {
    const endpoint = parseRawOpenShellAllowedIpsRebindingEndpoint(`Version: 1
---
version: 1
network_policies:
  ${RAW_OPENSHELL_REBIND_POLICY_KEY}:
    endpoints:
      - host: ${RAW_OPENSHELL_REBIND_HOSTNAME}
        port: 31337
        protocol: mcp
        allowed_ips:
          - '${RAW_OPENSHELL_REBIND_PINNED_IP}'
`);

    expect(endpoint).toMatchObject({
      allowed_ips: [RAW_OPENSHELL_REBIND_PINNED_IP],
      host: RAW_OPENSHELL_REBIND_HOSTNAME,
      port: 31337,
      protocol: "mcp",
    });
  });

  it("passes only an exact HTTP 403 and rejects an allowed response", () => {
    const binDir = fakeCurlPath();
    const script = buildRawOpenShellAllowedIpsRebindingProbeScript(
      `http://${RAW_OPENSHELL_REBIND_HOSTNAME}:31337/mcp`,
    );
    const run = (status: string, curlRc = "0") =>
      spawnSync("/bin/bash", ["-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_CURL_RC: curlRc,
          FAKE_HTTP_STATUS: status,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      });

    const denied = run("403");
    expect(denied.status, denied.stderr).toBe(0);
    expect(denied.stdout).toContain(`${RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER}403`);

    const allowed = run("200");
    expect(allowed.status).toBe(1);
    expect(allowed.stdout).toContain(`${RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER}200`);

    const transportFailure = run("000", "7");
    expect(transportFailure.status).toBe(7);
  });

  it("runs the raw proof in both MCP lanes without calling an adapter and restores policy", () => {
    const mcpBridgeSource = fs.readFileSync("test/e2e/live/mcp-bridge.test.ts", "utf8");
    const networkPolicySource = fs.readFileSync("test/e2e/live/network-policy.test.ts", "utf8");
    const contractSource = fs.readFileSync(
      "test/e2e/live/openshell-allowed-ips-rebinding.ts",
      "utf8",
    );
    expect(
      mcpBridgeSource.match(/await assertRawOpenShellAllowedIpsRebindingDenied/g),
    ).toHaveLength(1);
    expect(networkPolicySource).not.toContain("assertRawOpenShellAllowedIpsRebindingDenied");
    expect(contractSource).toContain('["policy", "set", "--policy"');
    expect(contractSource).toContain("server.requestCount()");
    expect(contractSource).toContain("raw-openshell-rebinding-policy-restore");
    expect(contractSource).toContain("raw-openshell-rebinding-policy-verify-restored");
    expect(contractSource.indexOf("raw-openshell-rebinding-policy-restore")).toBeGreaterThan(
      contractSource.indexOf("} finally {"),
    );
    expect(contractSource).toContain(
      "https://github.com/NVIDIA/OpenShell/blob/3dee5570a46076a57a3b056f35f35ebc0861ac85/",
    );
    expect(contractSource).not.toContain("host.nemoclaw");
    expect(contractSource).not.toContain("assertAdapterDnsRebindingDenied");
  });

  it("runs the zero-upstream rebinding proof for all three adapters", () => {
    const source = fs.readFileSync("test/e2e/live/mcp-bridge.test.ts", "utf8");

    expect(source.match(/await assertAdapterDnsRebindingDenied/g)).toHaveLength(3);
    for (const adapter of [
      'adapter: "mcporter"',
      'adapter: "hermes-config"',
      'adapter: "deepagents-config"',
    ]) {
      expect(source).toContain(adapter);
    }
    expect(source).toContain("rebound request must not reach the upstream MCP server");
    expect(source).toContain(").toHaveLength(0);");
  });

  it("restores the DNS fixture before MCP removal can restart the sandbox", () => {
    const source = fs.readFileSync("test/e2e/live/mcp-bridge.test.ts", "utf8");
    const denialProof = source.indexOf("rebound request must not reach the upstream MCP server");
    const restore = source.indexOf("await restoreDnsRebindingHostsFixture", denialProof);
    const remove = source.indexOf("const remove = await host.nemoclaw", denialProof);

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
