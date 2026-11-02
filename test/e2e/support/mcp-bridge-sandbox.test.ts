// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import * as dnsServer from "../fixtures/dns-rebinding-server.ts";

import * as policy from "../../../src/lib/policy";
import { testTimeout } from "../../helpers/timeouts";
import {
  isExpectedMcpDnsPolicyDenial,
  waitForMcpCurlPolicyDenial,
} from "../fixtures/curl-policy-denial.ts";
import { createMcpFixtureTls } from "../fixtures/mcp-fixture-tls.ts";
import { startFakeMcpHttpsServer } from "../live/mcp-bridge-servers.ts";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import {
  assertManagedMcpPolicySurvivedRemoval,
  buildMcpDnsRebindingProbeScript,
  captureManagedMcpPolicy,
  hostAddressForSandbox,
  hostPrivateAddressForSandbox,
  isExpectedMcpCurlPolicyDenial,
  restoreDnsRebindingHostsFixture,
  setupDnsRebindingHostsFixture,
  remapDnsRebindingHostname,
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
const WORKLOAD_ID = "a".repeat(64);
const SUPERVISOR_ID = "b".repeat(64);

function resolverRecord(id: string, role: string | null, name = "test-sandbox") {
  return {
    id,
    role,
    name,
    sandboxId: "sandbox-id",
    namespace: "default",
    running: true,
    pid: 321,
    networkMode: "host",
    resolvPath: `/var/lib/docker/containers/${id}/resolv.conf`,
  };
}

beforeEach(() => {
  vi.spyOn(dnsServer, "startRebindingDnsServer").mockResolvedValue({
    port: 1053,
    family: 4,
    answers: () => 1,
    setAddress: vi.fn(),
    close: vi.fn(async () => {}),
  });
});

afterEach(() => {
  vi.useRealTimers();
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
    signal: null,
    exitCode: overrides.exitCode ?? 0,
    stderr: overrides.stderr ?? "",
    stdout: overrides.stdout ?? "",
    timedOut: overrides.timedOut ?? false,
  };
}

describe("MCP curl policy denial classification", SUITE_OPTIONS, () => {
  it.each([
    {},
    { managed: {} },
    { managed: { endpoints: [{ host: "other.example.test", allowed_ips: ["10.0.0.2"] }] } },
    { managed: { endpoints: [{ host: "mcp.example.test", allowed_ips: [] }] } },
  ])("rejects missing or mismatched managed endpoint evidence %j", async (networkPolicies) => {
    const sandbox = {
      openshell: async () => ({
        ...denialResult(),
        stdout: YAML.stringify({ version: 1, network_policies: networkPolicies }),
      }),
    } as unknown as SandboxClient;
    await expect(
      captureManagedMcpPolicy(sandbox, {
        artifactName: "managed-policy",
        label: "capture managed policy",
        policyKey: "managed",
        sandboxName: "test-sandbox",
        url: "https://mcp.example.test/mcp",
      }),
    ).rejects.toThrow(/expected managed MCP host|expected at least one managed MCP address pin/);
  });

  it("binds DNS redirection to the selected supervisor cgroup", async () => {
    const role = "sandbox";
    const id = SUPERVISOR_ID;
    const command = vi.fn(
      async (_command: string, args: string[], options?: { artifactName?: string }) => {
        const stdout =
          {
            "dns-rebinding-workload-resource": `${WORKLOAD_ID}\t${role ?? ""}\n`,
            "dns-rebinding-supervisor-resource": `${SUPERVISOR_ID}\n`,
            "dns-rebinding-resolver-cgroup": JSON.stringify({
              cgroup: `system.slice/docker-${SUPERVISOR_ID}.scope`,
              upstream: "127.0.0.53",
            }),
            "dns-rebinding-resolver-identity": JSON.stringify(
              resolverRecord(args.at(-1)!, args.at(-1) === WORKLOAD_ID ? role : "supervisor"),
            ),
          }[options?.artifactName ?? ""] ?? "";
        return { ...denialResult(), stdout };
      },
    );
    const host = { command } as unknown as HostCliClient;
    const fixture = await setupDnsRebindingHostsFixture(
      host,
      "test-sandbox",
      "rebind.example.test",
    );
    expect(fixture).toMatchObject({
      containerId: id,
      cgroup: `system.slice/docker-${id}.scope`,
      upstream: "127.0.0.53",
    });
    await remapDnsRebindingHostname(host, "test-sandbox", fixture, "10.20.30.40", "remap");
    const script = command.mock.calls.at(-1)![1][1];
    expect(script).toContain("sudo -n tee /etc/hosts");
    const rule = command.mock.calls.find(([, args]) => args.includes("-A"))?.[1];
    expect(rule).toEqual(
      expect.arrayContaining([
        "--path",
        `system.slice/docker-${id}.scope`,
        "-d",
        "127.0.0.53",
        "--dport",
        "53",
      ]),
    );
    await restoreDnsRebindingHostsFixture(host, "test-sandbox", fixture);
  });

  it.each(["duplicate", "wrong-namespace", "wrong-path", "stopped"])(
    "rejects %s resolver evidence before modifying DNS",
    async (failure) => {
      const command = vi.fn(
        async (_command: string, args: string[], options?: { artifactName?: string }) => {
          const id = args.at(-1)!;
          const supervisorOverrides = {
            duplicate: {},
            "wrong-namespace": { namespace: "other" },
            "wrong-path": { resolvPath: "/etc/resolv.conf" },
            stopped: { running: false },
          }[failure];
          const record = {
            ...resolverRecord(id, id === WORKLOAD_ID ? "sandbox" : "supervisor"),
            ...(id === SUPERVISOR_ID ? supervisorOverrides : {}),
          };
          const stdout =
            {
              "dns-rebinding-workload-resource": `${WORKLOAD_ID}\tsandbox\n`,
              "dns-rebinding-supervisor-resource":
                failure === "duplicate" ? `${SUPERVISOR_ID}\n${SUPERVISOR_ID}` : SUPERVISOR_ID,
              "dns-rebinding-resolver-identity": JSON.stringify(record),
            }[options?.artifactName ?? ""] ?? `${WORKLOAD_ID}\tsandbox\n`;
          return { ...denialResult(), stdout };
        },
      );
      await expect(
        setupDnsRebindingHostsFixture(
          { command } as unknown as HostCliClient,
          "test-sandbox",
          "rebind.example.test",
        ),
      ).rejects.toThrow();
      expect(command.mock.calls.some(([name]) => name === "bash")).toBe(false);
    },
  );

  it("separates the managed endpoint alias from the concrete rebinding address", async () => {
    let probeScript = "";
    const host = {
      command: async (_command: string, args: string[]) => {
        probeScript = args[1] ?? "";
        return { ...denialResult(), stdout: "route 10.20.30.40\n" };
      },
    } as unknown as HostCliClient;

    await expect(hostAddressForSandbox(host)).resolves.toBe("host.openshell.internal");
    await expect(hostPrivateAddressForSandbox(host)).resolves.toBe("10.20.30.40");
    expect(probeScript).toContain("ip route get 1.1.1.1");
  });

  it("accepts an L7 HTTP 403 denial", () => {
    expect(
      isExpectedMcpCurlPolicyDenial(
        denialResult({ stdout: '{"error":"policy_denied"}\nNEMOCLAW_MCP_CURL_HTTP_CODE=403\n' }),
      ),
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

  it.each([
    ["* Immediate connect fail for 198.18.0.1: Permission denied", true],
    ["* Immediate connect fail for fd00::1: Permission denied", true],
    ["* Immediate connect fail for 198.18.0.1: Connection refused", false],
    [
      "* Immediate connect fail for 198.18.0.1: Permission denied\n* Immediate connect fail for fd00::1: Connection refused",
      false,
    ],
    ["curl: (7) Permission denied", false],
    ["* Failed to open file: Permission denied", false],
    ["curl: (6) Could not resolve host", false],
    [
      "* Immediate connect fail for 198.18.0.1: Permission denied\n* connect to 10.0.0.1 port 443 from 10.0.0.2 port 5000 failed: Connection refused",
      false,
    ],
  ])("classifies curl connect diagnostic %s", (stderr, expected) => {
    expect(
      isExpectedMcpCurlPolicyDenial(
        denialResult({ exitCode: 7, stdout: "NEMOCLAW_MCP_CURL_HTTP_CODE=000\n", stderr }),
      ),
    ).toBe(expected);
  });

  it.each([
    ["000", 7, "* Immediate connect fail for 198.18.0.1: Permission denied", false],
    ["302", 7, "* Immediate connect fail for 198.18.0.1: Permission denied", true],
    ["302", 7, "* Immediate connect fail for 198.18.0.1: Connection refused", false],
    ["302", 7, "curl: (7) Permission denied", false],
    ["302", 0, "", false],
    ["302", 28, "* Immediate connect fail for 198.18.0.1: Permission denied", false],
  ] as const)(
    "requires explicit redirect evidence %s/%s/%s",
    (expectedCode, exitCode, stderr, expected) => {
      expect(
        isExpectedMcpCurlPolicyDenial(
          denialResult({
            exitCode,
            stdout:
              "HTTP/1.1 302 Found\r\nlocation: http://host.openshell.internal:8000/v1/chat/completions\r\n\r\nNEMOCLAW_MCP_CURL_HTTP_CODE=302\n",
            stderr,
          }),
          "NEMOCLAW_MCP_CURL_HTTP_CODE=",
          expectedCode,
        ),
      ).toBe(expected);
    },
  );

  it.each([
    "NEMOCLAW_MCP_CURL_HTTP_CODE=403\nNEMOCLAW_MCP_CURL_HTTP_CODE=200\npolicy_denied",
    "NEMOCLAW_MCP_CURL_HTTP_CODE=403\nNEMOCLAW_MCP_CURL_HTTP_CODE=403\npolicy_denied",
    "NEMOCLAW_MCP_CURL_HTTP_CODE=403\ncredential_endpoint_mismatch",
  ])("rejects ambiguous or nonpolicy HTTP evidence [case %#]", (stdout) => {
    expect(isExpectedMcpCurlPolicyDenial(denialResult({ stdout }))).toBe(false);
  });

  it.each(["openclaw-config", "hermes-config", "deepagents-config", null] as const)(
    "executes curl with adapter %s and removes outgoing header diagnostics",
    (adapter) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-curl-command-"));
      tempDirs.push(directory);
      const capture = path.join(directory, "argv");
      fs.writeFileSync(path.join(directory, "nemoclaw-start"), '#!/bin/sh\nexec "$@"\n', {
        mode: 0o755,
      });
      fs.writeFileSync(
        path.join(directory, "curl"),
        '#!/bin/sh\nprintf "%s\\n" "$@" > "$CURL_ARGV_CAPTURE"\nprintf "NEMOCLAW_MCP_CURL_HTTP_CODE=200\\n"\nprintf "> authorization: Bearer runtime-handle\\n* Immediate connect fail for 198.18.0.1: Permission denied\\n" >&2\n',
        { mode: 0o755 },
      );
      const script = buildMcpDnsRebindingProbeScript(
        adapter,
        "https://mcp.example.test/mcp",
        "REBIND_MCP_SECRET",
      )
        .replaceAll("/tmp/nemoclaw-mcp-rebinding", path.join(directory, "probe"))
        .replace("/opt/hermes/.venv/bin/python", "python3")
        .replace("/opt/venv/bin/python3", "python3");
      const result = spawnSync("/bin/bash", ["-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          CURL_ARGV_CAPTURE: capture,
          REBIND_MCP_SECRET: "openshell:resolve:env:v1_REBIND_MCP_SECRET",
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(capture, "utf8")).toContain(
        adapter === null
          ? "authorization: Bearer openshell:resolve:env:REBIND_MCP_SECRET"
          : "authorization: Bearer openshell:resolve:env:v1_REBIND_MCP_SECRET",
      );
      const argumentsCaptured = fs.readFileSync(capture, "utf8").trim().split("\n");
      expect(JSON.parse(argumentsCaptured.at(-1)!)).toMatchObject({
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      });
      expect(argumentsCaptured).not.toContain("mcp-protocol-version: 2025-11-25");
      expect(result.stderr).not.toContain("authorization:");
      expect(result.stderr).toContain("Immediate connect fail");
    },
  );

  it.each([true, false])(
    "sends one initialization control with accepted credential=%s",
    async (accepted) => {
      const tls = createMcpFixtureTls();
      const server = await startFakeMcpHttpsServer({
        tls: tls.tls,
        secret: accepted ? "openshell:resolve:env:REBIND_MCP_SECRET" : "different-credential",
      });
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rebind-initialize-"));
      tempDirs.push(directory);
      const caPath = path.join(directory, "ca.pem");
      fs.writeFileSync(caPath, tls.tls.cert);
      try {
        const script = buildMcpDnsRebindingProbeScript(
          null,
          `https://127.0.0.1:${server.port}/mcp`,
          "REBIND_MCP_SECRET",
        ).replaceAll("/tmp/nemoclaw-mcp-rebinding", path.join(directory, "probe"));
        const result = await promisify(execFile)("/bin/bash", ["-c", script], {
          env: { ...process.env, CURL_CA_BUNDLE: caPath },
          timeout: 10_000,
        });
        expect(result.stdout).toContain(`NEMOCLAW_MCP_CURL_HTTP_CODE=${accepted ? 200 : 401}`);
        expect(
          server.requests.map((request) => ({
            method: request.method,
            path: request.path,
            rpcMethod: request.rpcMethod,
            id: JSON.parse(request.body).id,
            auth: request.auth,
            sessionId: request.sessionId,
            protocolVersion: request.protocolVersion,
          })),
        ).toEqual([
          {
            method: "POST",
            path: "/mcp",
            rpcMethod: "initialize",
            id: 1,
            auth: "Bearer openshell:resolve:env:REBIND_MCP_SECRET",
            sessionId: "",
            protocolVersion: "",
          },
        ]);
        expect(result.stderr).not.toContain("authorization:");
      } finally {
        await server.close();
        tls.close();
      }
    },
  );

  it("runs the rebinding request beneath each adapter runtime identity", () => {
    const runtimes = {
      "openclaw-config": "nemoclaw-start node -e",
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
      expect(script, adapter).toContain("NEMOCLAW_MCP_AUTHORIZATION");
      expect(script, adapter).not.toContain("fake-rebind-mcp-secret-value");
      const syntax = spawnSync("/bin/bash", ["-n"], { input: script, encoding: "utf8" });
      expect(syntax.status, `${adapter}: ${syntax.stderr}`).toBe(0);
    });
  });

  it("pins the resolve-validate-connect source contract to OpenShell v0.1.2", () => {
    const commit = "6648bd0c290efbc41ba131ee9831ee45cd431f94";
    const sourcePath = "crates/openshell-supervisor-network/src/proxy.rs";
    const sourceUrl = `https://github.com/NVIDIA/OpenShell/blob/${commit}/${sourcePath}`;
    const citations = [
      `${sourceUrl}#L4201-L4230`,
      `${sourceUrl}#L4255-L4295`,
      `${sourceUrl}#L4327-L4388`,
      `${sourceUrl}#L4342-L4375`,
      `${sourceUrl}#L5967-L6037`,
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
        enforcement: "enforce",
        mcp: {
          versions: ["2025-11-25"],
          max_body_bytes: 4096,
          strict_tool_names: true,
          allow_all_known_mcp_methods: false,
        },
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

  it("preserves raw HTTP and transport outcomes for the strict caller", () => {
    const binDir = fakeCurlPath();
    const script = buildRawOpenShellAllowedIpsRebindingProbeScript(
      `http://${RAW_OPENSHELL_REBIND_HOSTNAME}:31337/mcp`,
      binDir,
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
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toContain(`${RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER}200`);

    const transportFailure = run("000", "7");
    expect(transportFailure.status).toBe(7);
  });

  it.each(["http", "dns"])(
    "applies and restores the raw proof after %s policy denial",
    async (transport) => {
      const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-raw-policy-proof-"));
      tempDirs.push(rootDir);
      const artifacts = new ArtifactSink(path.join(rootDir, "artifacts"));
      await artifacts.ensureRoot();
      const basePolicy = "version: 1\nnetwork_policies: {}\n";
      let currentPolicy = basePolicy;
      const policyMutations: Array<{ document: string; operation: string | undefined }> = [];
      const setPolicy = vi
        .spyOn(policy, "setPolicyDocument")
        .mockImplementation(async (_sandboxName, document, options) => {
          currentPolicy = document;
          policyMutations.push({ document, operation: options?.operation });
          return true;
        });
      const host = {
        command: async (
          _command: string,
          _args: string[],
          options?: { artifactName?: string },
        ) => ({
          ...denialResult(),
          stdout:
            {
              "host-address-for-sandbox": "route 10.20.30.40\n",
              "dns-rebinding-workload-resource": `${WORKLOAD_ID}\tsandbox\n`,
              "dns-rebinding-supervisor-resource": SUPERVISOR_ID,
              "dns-rebinding-resolver-cgroup": JSON.stringify({
                cgroup: `system.slice/docker-${SUPERVISOR_ID}.scope`,
                upstream: "127.0.0.53",
              }),
              "dns-rebinding-resolver-identity": JSON.stringify(
                resolverRecord(
                  _args.at(-1)!,
                  _args.at(-1) === WORKLOAD_ID ? "sandbox" : "supervisor",
                  "raw-proof",
                ),
              ),
            }[options?.artifactName ?? ""] ?? "",
        }),
      } as unknown as HostCliClient;
      const openshellCalls: string[][] = [];
      let denialExecuted = false;
      const sandbox = {
        openshell: async (args: string[]) => {
          openshellCalls.push(args);
          return {
            ...denialResult(),
            stdout:
              args[0] === "logs"
                ? denialExecuted
                  ? `2026-10-20T20:41:43.600Z OCSF NET:REFUSE [MED] DENIED ${RAW_OPENSHELL_REBIND_HOSTNAME} [reason:policy_dns_no_valid_address]\n`
                  : ""
                : args.includes("--full")
                  ? currentPolicy
                  : basePolicy,
          };
        },
        execShell: async (
          _name: string,
          _script: unknown,
          options: {
            artifactName:
              | "raw-openshell-rebinding-allowed-control"
              | "raw-openshell-rebinding-policy-denial";
          },
        ) =>
          ({
            "raw-openshell-rebinding-allowed-control": async () => {
              const port =
                YAML.parse(currentPolicy).network_policies[RAW_OPENSHELL_REBIND_POLICY_KEY]
                  .endpoints[0].port;
              const response = await fetch(`http://127.0.0.1:${port}/mcp`);
              await response.text();
              return {
                ...denialResult(),
                stdout: `${RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER}${response.status}\n`,
              };
            },
            "raw-openshell-rebinding-policy-denial": async () => {
              denialExecuted = true;
              return transport === "dns"
                ? denialResult({
                    exitCode: 6,
                    stdout: `${RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER}000\n`,
                    stderr: `curl: (6) Could not resolve host: ${RAW_OPENSHELL_REBIND_HOSTNAME}\n`,
                  })
                : denialResult({
                    stdout: `{"error":"policy_denied"}\n${RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER}403\n`,
                  });
            },
          })[options.artifactName]!(),
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

      expect(policyMutations).toHaveLength(3);
      expect(policyMutations[0]?.document).toContain(RAW_OPENSHELL_REBIND_POLICY_KEY);
      expect(policyMutations[0]?.operation).toBe("allow the raw OpenShell rebinding control");
      expect(policyMutations[1]?.operation).toBe(
        "run the raw OpenShell allowed_ips rebinding proof",
      );
      expect(policyMutations[2]?.document).toBe(basePolicy.trim());
      expect(policyMutations[2]?.operation).toBe(
        "restore the raw OpenShell allowed_ips rebinding proof policy",
      );
      expect(openshellCalls.some((args) => args[0] === "policy" && args[1] === "set")).toBe(false);
    },
  );

  it.each([
    [RAW_OPENSHELL_REBIND_HOSTNAME, RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER],
    ["mcp-rebind.example.test", "NEMOCLAW_MCP_CURL_HTTP_CODE="],
    ["inference-rebind.trycloudflare.com", "NEMOCLAW_INFERENCE_CURL_HTTP_CODE="],
  ])("accepts only a fresh exact policy DNS refusal for %s", (hostname, marker) => {
    const result = denialResult({
      exitCode: 6,
      stdout: `${marker}000\n`,
      stderr: `curl: (6) Could not resolve host: ${hostname}\n`,
    });
    const event = `2026-10-20T20:41:43.600Z OCSF NET:REFUSE [MED] DENIED ${hostname} [reason:policy_dns_no_valid_address]\n`;
    expect(
      isExpectedMcpDnsPolicyDenial(
        result,
        denialResult(),
        denialResult({ stdout: event }),
        hostname,
        marker,
      ),
    ).toBe(true);
    expect(
      isExpectedMcpDnsPolicyDenial(
        result,
        denialResult({ exitCode: 1 }),
        denialResult({ stdout: event }),
        hostname,
        marker,
      ),
    ).toBe(false);
    expect(
      isExpectedMcpDnsPolicyDenial(
        result,
        denialResult(),
        denialResult({ stdout: event }),
        "other.example.test",
        marker,
      ),
    ).toBe(false);
  });

  it.each([
    ["first read", "after-1", [0], true],
    ["delayed third read", "after-3", [0, 250, 500], true],
    ["exhausted reads", null, [0, 250, 500, 750, 1000], false],
  ] as const)(
    "confirms DNS denial with bounded audit polling: %s",
    async (_name, freshAt, times, expected) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const hostname = "inference-rebind.trycloudflare.com";
      const marker = "NEMOCLAW_INFERENCE_CURL_HTTP_CODE=";
      const result = denialResult({
        exitCode: 6,
        stdout: `${marker}000\n`,
        stderr: `curl: (6) Could not resolve host: ${hostname}\n`,
      });
      const before = denialResult();
      const after = denialResult({
        stdout: `fresh OCSF NET:REFUSE [MED] DENIED ${hostname} [reason:policy_dns_no_valid_address]\n`,
      });
      const observedTimes: number[] = [];
      const readAudit = vi.fn(async (suffix: string) => {
        observedTimes.push(Date.now());
        return suffix === freshAt ? after : before;
      });
      const confirmation = waitForMcpCurlPolicyDenial(result, before, readAudit, hostname, marker);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await confirmation).toBe(expected);
      expect(observedTimes).toEqual(times);
      expect(readAudit.mock.calls.at(-1)).toEqual([`after-${times.length}`]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    [
      7,
      "NEMOCLAW_MCP_CURL_HTTP_CODE=000\n",
      "* Immediate connect fail for 192.0.2.1: Permission denied\n",
      true,
    ],
    [
      7,
      "NEMOCLAW_MCP_CURL_HTTP_CODE=000\n",
      "* connect to 192.0.2.1 port 443 failed: Connection refused\n",
      false,
    ],
    [0, "policy_denied\nNEMOCLAW_MCP_CURL_HTTP_CODE=403\n", "", true],
  ] as const)(
    "does not read DNS logs for a completed non-DNS result [case %#]",
    async (exitCode, stdout, stderr, expected) => {
      const readAudit = vi.fn(async () => denialResult());
      const result = denialResult({ exitCode, stdout, stderr });
      expect(
        await waitForMcpCurlPolicyDenial(result, denialResult(), readAudit, "mcp.example.test"),
      ).toBe(expected);
      expect(readAudit).not.toHaveBeenCalled();
    },
  );

  it.each([
    "missing",
    "stale",
    "other-host",
    "upstream-nxdomain",
    "audit-failed",
    "timeout",
    "http-success",
  ])("rejects a raw DNS denial with %s evidence", (condition) => {
    const event = `2026-10-20T20:41:43.600Z OCSF NET:REFUSE [MED] DENIED ${RAW_OPENSHELL_REBIND_HOSTNAME} [reason:policy_dns_no_valid_address]\n`;
    const result = denialResult({
      exitCode: 6,
      stdout: `${RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER}${condition === "http-success" ? "200" : "000"}\n`,
      stderr: `curl: (6) Could not resolve host: ${RAW_OPENSHELL_REBIND_HOSTNAME}\n`,
      timedOut: condition === "timeout",
    });
    const before = denialResult({ stdout: condition === "stale" ? event : "" });
    const after = denialResult({
      exitCode: condition === "audit-failed" ? 1 : 0,
      stdout:
        condition === "missing"
          ? ""
          : condition === "other-host"
            ? event.replace(RAW_OPENSHELL_REBIND_HOSTNAME, "other.example.test")
            : condition === "upstream-nxdomain"
              ? event.replace("policy_dns_no_valid_address", "policy_dns_upstream_nxdomain")
              : event,
    });
    expect(
      isExpectedMcpDnsPolicyDenial(
        result,
        before,
        after,
        RAW_OPENSHELL_REBIND_HOSTNAME,
        RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER,
      ),
    ).toBe(false);
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

  function cleanupFixture(failure: string) {
    const close = vi.fn(async () => {});
    const removeBackup = vi.fn();
    const command = vi.fn(
      async (_command: string, _args: string[], options?: { artifactName?: string }) => ({
        ...denialResult(),
        exitCode:
          (failure === "rule-removal" && options?.artifactName?.includes("-D-")) ||
          (failure === "rule-inventory" &&
            options?.artifactName === "dns-rebinding-rules-absent") ||
          (failure === "host-restore" && options?.artifactName === "dns-rebinding-restore-hosts")
            ? 1
            : 0,
      }),
    );
    const fixture = {
      hostname: "mcp-rebind.example.test",
      hostBackupPath: "/tmp/fixture/hosts",
      backupReady: true,
      removeBackup,
      containerId: SUPERVISOR_ID,
      pid: 321,
      cgroup: `system.slice/docker-${SUPERVISOR_ID}.scope`,
      upstream: "127.0.0.53",
      comment: "owned-fixture",
      restored: false,
      server: { port: 1053, family: 4, answers: () => 1, setAddress: vi.fn(), close },
    };
    return { command, fixture, close, removeBackup };
  }

  it("restores hosts, removes DNS rules, and closes the forwarder once", async () => {
    const { command, fixture, close, removeBackup } = cleanupFixture("success");
    await restoreDnsRebindingHostsFixture(
      { command } as unknown as HostCliClient,
      "test-sandbox",
      fixture,
    );
    expect(close).toHaveBeenCalledOnce();
    expect(fixture.restored).toBe(true);
    expect(removeBackup).toHaveBeenCalledOnce();
    const calls = command.mock.calls.length;
    await restoreDnsRebindingHostsFixture(
      { command } as unknown as HostCliClient,
      "test-sandbox",
      fixture,
    );
    expect(command).toHaveBeenCalledTimes(calls);
  });

  it.each([
    { failure: "rule-removal", backupRemovals: 1 },
    { failure: "rule-inventory", backupRemovals: 1 },
    { failure: "host-restore", backupRemovals: 0 },
  ])(
    "closes the DNS forwarder and reports $failure cleanup failure",
    async ({ failure, backupRemovals }) => {
      const { command, fixture, close, removeBackup } = cleanupFixture(failure);
      await expect(
        restoreDnsRebindingHostsFixture(
          { command } as unknown as HostCliClient,
          "test-sandbox",
          fixture,
        ),
      ).rejects.toThrow("DNS fixture cleanup failed");
      expect(close).toHaveBeenCalledOnce();
      expect(fixture.restored).toBe(false);
      expect(removeBackup).toHaveBeenCalledTimes(backupRemovals);
    },
  );
});
