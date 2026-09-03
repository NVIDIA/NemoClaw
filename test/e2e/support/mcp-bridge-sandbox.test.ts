// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import * as policy from "../../../src/lib/policy";
import { testTimeout } from "../../helpers/timeouts";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  assertManagedMcpPolicySurvivedRemoval,
  buildMcpDnsRebindingProbeScript,
  hostAddressForSandbox,
  hostPrivateAddressForSandbox,
  isExpectedMcpCurlPolicyDenial,
  restoreDnsRebindingHostsFixture,
} from "../live/mcp-bridge-sandbox.ts";
import {
  assertRawOpenShellAllowedIpsRebindingDenied,
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

    Object.entries(runtimes).forEach(([adapter, runtime]) => {
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
    });
  });

  it("pins the resolve-validate-connect source contract to OpenShell v0.0.106", () => {
    const commit = "c4b500a7de64d0b66e3ee8098f58d14299092162";
    const sourcePath = "crates/openshell-supervisor-network/src/proxy.rs";
    const citations = [
      `${sourcePath}:3070-3096`,
      `${sourcePath}:3121-3160`,
      `${sourcePath}:3193-3251`,
      `${sourcePath}:3208-3240`,
      `${sourcePath}:4783-4850`,
    ];

    const docsPath = "docs/deployment/set-up-mcp-bridge.mdx";
    const docs = fs.readFileSync(docsPath, "utf8");
    expect(docs, docsPath).toContain(commit);
    expect(citations.every((citation) => docs.includes(citation))).toBe(true);
    expect(docs).toContain("proxy_connect_by_hostname");
    expect(docs).toContain("reopens proxy-side DNS resolution");
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

  it("applies and restores the raw proof through live OpenShell policy authority", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-raw-policy-proof-"));
    tempDirs.push(rootDir);
    const artifacts = new ArtifactSink(path.join(rootDir, "artifacts"));
    await artifacts.ensureRoot();
    const basePolicy = "version: 1\nnetwork_policies: {}\n";
    let currentPolicy = basePolicy;
    const policyMutations: Array<{ document: string; operation: string | undefined }> = [];
    const setPolicy = vi
      .spyOn(policy, "setPolicyDocument")
      .mockImplementation((_sandboxName, document, options) => {
        currentPolicy = document;
        policyMutations.push({ document, operation: options?.operation });
        return true;
      });
    const host = {
      command: async (_command: string, _args: string[], options?: { artifactName?: string }) => ({
        ...denialResult(),
        stdout: options?.artifactName === "host-address-for-sandbox" ? "route 10.20.30.40\n" : "",
      }),
    } as unknown as HostCliClient;
    const openshellCalls: string[][] = [];
    const sandbox = {
      openshell: async (args: string[]) => {
        openshellCalls.push(args);
        return {
          ...denialResult(),
          stdout: args.includes("--full") ? currentPolicy : basePolicy,
        };
      },
      execShell: async () => ({
        ...denialResult(),
        stdout: `${RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER}403\n`,
      }),
    } as never;

    try {
      await assertRawOpenShellAllowedIpsRebindingDenied({
        artifacts,
        host,
        policySettleMs: 0,
        sandbox,
        sandboxName: "raw-proof",
        timeoutMs: 1_000,
      });
    } finally {
      setPolicy.mockRestore();
    }

    expect(policyMutations).toHaveLength(2);
    expect(policyMutations[0]?.document).toContain(RAW_OPENSHELL_REBIND_POLICY_KEY);
    expect(policyMutations[0]?.operation).toBe("run the raw OpenShell allowed_ips rebinding proof");
    expect(policyMutations[1]?.document).toBe(basePolicy.trim());
    expect(policyMutations[1]?.operation).toBe(
      "restore the raw OpenShell allowed_ips rebinding proof policy",
    );
    expect(openshellCalls.some((args) => args[0] === "policy" && args[1] === "set")).toBe(false);
  });

  it("accepts an unchanged surviving policy only after the unrelated policy is absent", () => {
    const survivingPolicyBefore = {
      endpoints: [{ host: "surviving.example.test", allowed_ips: ["203.0.113.10"] }],
    };
    const survivingPolicyAfter = {
      endpoints: [{ host: "surviving.example.test", allowed_ips: ["203.0.113.10"] }],
    };
    const changedSurvivingPolicy = {
      endpoints: [{ host: "changed.example.test", allowed_ips: ["203.0.113.10"] }],
    };

    expect(() =>
      assertManagedMcpPolicySurvivedRemoval(
        survivingPolicyBefore,
        {
          networkPolicies: { mcp_bridge_surviving: survivingPolicyAfter },
          policy: survivingPolicyAfter,
        },
        "mcp_bridge_rebinding",
      ),
    ).not.toThrow();

    expect(() =>
      assertManagedMcpPolicySurvivedRemoval(
        survivingPolicyBefore,
        {
          networkPolicies: { mcp_bridge_surviving: changedSurvivingPolicy },
          policy: changedSurvivingPolicy,
        },
        "mcp_bridge_rebinding",
      ),
    ).toThrow();

    expect(() =>
      assertManagedMcpPolicySurvivedRemoval(
        survivingPolicyBefore,
        {
          networkPolicies: {
            mcp_bridge_rebinding: { endpoints: [] },
            mcp_bridge_surviving: survivingPolicyAfter,
          },
          policy: survivingPolicyAfter,
        },
        "mcp_bridge_rebinding",
      ),
    ).toThrow();
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
