// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { parseAndValidateSandboxPolicy } from "../../../src/lib/policy/sandbox-policy-validation.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  applyFixtureProviderPolicyEndpoint,
  clearFixtureProviderPolicyEndpoint,
  rebindFixtureProviderPolicyEndpoint,
} from "../fixtures/gateway-providers.ts";
import { requireSuccessfulPolicyBoundaryBuild } from "../fixtures/hermes-discord-policy-boundary-build.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  applyRestRewritePolicy,
  applyWebSocketRewritePolicy,
} from "../live/messaging-providers-helpers.ts";

const HELPER = path.resolve(import.meta.dirname, "../fixtures/gateway-provider-policy-binding.ts");
const TYPESCRIPT = path.resolve("node_modules/typescript/bin/tsc");
const POLICY_BOUNDARY_CONFIG = path.resolve("nemoclaw/tsconfig.shared.json");
const tempDirs: string[] = [];

function runBinding(policyFile: string, protocol = "websocket") {
  return spawnSync(
    process.execPath,
    [
      "--disable-warning=DEP0205",
      "--import",
      "tsx",
      HELPER,
      policyFile,
      "e2e-hermes-discord-discord-bridge",
      "host.docker.internal",
      "43117",
      protocol,
    ],
    { encoding: "utf8", killSignal: "SIGKILL", timeout: 15_000 },
  );
}

function runUnbind(policyFile: string) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      HELPER,
      "--unbind-provider",
      policyFile,
      "e2e-hermes-discord-discord-bridge",
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
}

function successfulProbe(stdout = ""): ShellProbeResult {
  return {
    command: ["openshell"],
    durationMs: 1,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    artifacts: { stdout: "stdout", stderr: "stderr", result: "result" },
  };
}

function fixtureBindingCleanupHarness(fixtureProvider = "telegram-provider") {
  const original = {
    version: 1,
    network_policies: {
      telegram: {
        endpoints: [
          {
            host: "api.telegram.org",
            port: 443,
            credential_binding: { provider: "telegram-provider" },
          },
        ],
      },
      fixture: {
        endpoints: [
          {
            host: "host.openshell.internal",
            port: 43119,
            protocol: "rest",
            credential_binding: { provider: fixtureProvider },
          },
        ],
      },
    },
  };
  const applied: unknown[] = [];
  const command = vi
    .fn<HostCliClient["command"]>()
    .mockResolvedValueOnce(successfulProbe(YAML.stringify(original)))
    .mockImplementationOnce(async (_command, args = []) => {
      applied.push(YAML.parse(fs.readFileSync(args[args.indexOf("--policy") + 1], "utf8")));
      return successfulProbe();
    });
  const host = {
    command,
    openshellCommandPath: "/usr/local/bin/openshell",
  } as unknown as HostCliClient;
  const clear = () =>
    clearFixtureProviderPolicyEndpoint(host, "e2e-telegram", {
      artifactName: "clear-fake-telegram-binding",
      endpoint: { host: "host.openshell.internal", port: 43119, protocol: "rest" },
      env: {},
      providerName: "telegram-provider",
      redactionValues: [],
    });
  return { applied, clear, original };
}

function runBinaryAssertion(policyFile: string) {
  return spawnSync(
    process.execPath,
    [
      "--disable-warning=DEP0205",
      "--import",
      "tsx",
      HELPER,
      "--assert-binaries",
      policyFile,
      "host.docker.internal",
      "43117",
      "websocket",
      "/opt/hermes/.venv/bin/python",
    ],
    { encoding: "utf8", killSignal: "SIGKILL", timeout: 15_000 },
  );
}

describe("Hermes Discord E2E policy binding", () => {
  beforeAll(async () => {
    const result = spawnSync(process.execPath, [TYPESCRIPT, "-p", POLICY_BOUNDARY_CONFIG], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 15_000,
    });
    await requireSuccessfulPolicyBoundaryBuild(result);
  });

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("clears the fake endpoint binding while preserving the real Telegram binding for removal", async () => {
    const { applied, clear, original } = fixtureBindingCleanupHarness();
    await clear();
    expect(applied).toEqual([
      {
        ...original,
        network_policies: {
          telegram: original.network_policies.telegram,
          fixture: {
            endpoints: [{ host: "host.openshell.internal", port: 43119, protocol: "rest" }],
          },
        },
      },
    ]);
  });

  it("refuses to clear a fixture endpoint bound to another provider", async () => {
    const { applied, clear } = fixtureBindingCleanupHarness("another-provider");
    await expect(clear()).rejects.toThrow("belongs to another provider");
    expect(applied).toEqual([]);
  });

  const applySharedPolicy = (
    host: HostCliClient,
    protocol: "rest" | "websocket",
    restMethods?: readonly ("GET" | "POST")[],
  ) =>
    applyFixtureProviderPolicyEndpoint(host, "e2e-messaging", {
      artifactName: "apply-fake-messaging-policy",
      endpoint: { port: 43119 },
      protocol,
      rewrite: {
        rest: "request-body-credential-rewrite",
        websocket: "websocket-credential-rewrite",
      }[protocol] as "request-body-credential-rewrite" | "websocket-credential-rewrite",
      env: {},
      providerName: "messaging-provider",
      redactionValues: [],
      restMethods,
    });
  const applyMessagingPolicy = (host: HostCliClient, apply: typeof applyRestRewritePolicy) =>
    apply(
      host,
      { kind: "discord-gateway", port: "43119", captureFile: "unused" },
      "messaging-provider",
      "DISCORD_BOT_TOKEN",
      { DISCORD_BOT_TOKEN: "fixture-token" },
      ["fixture-token"],
    );

  it.each([
    {
      caller: "shared",
      protocol: "rest",
      expected: ["GET", "POST"],
      apply: (host: HostCliClient) => applySharedPolicy(host, "rest"),
    },
    {
      caller: "shared",
      protocol: "rest",
      expected: ["POST"],
      apply: (host: HostCliClient) => applySharedPolicy(host, "rest", ["POST"]),
    },
    {
      caller: "shared",
      protocol: "websocket",
      expected: ["GET", "WEBSOCKET_TEXT"],
      apply: (host: HostCliClient) => applySharedPolicy(host, "websocket"),
    },
    {
      caller: "messaging",
      protocol: "rest",
      expected: ["GET", "POST"],
      apply: (host: HostCliClient) => applyMessagingPolicy(host, applyRestRewritePolicy),
    },
    {
      caller: "messaging",
      protocol: "websocket",
      expected: ["GET", "WEBSOCKET_TEXT"],
      apply: (host: HostCliClient) => applyMessagingPolicy(host, applyWebSocketRewritePolicy),
    },
  ] as const)(
    "applies $caller $protocol fixture rules without mixing endpoint and rule updates [case %#]",
    async ({ protocol, expected, apply }) => {
      const providerName = "messaging-provider";
      const source = YAML.stringify({
        version: 1,
        network_policies: {
          fixture: {
            name: "fixture",
            endpoints: [
              {
                host: "host.openshell.internal",
                port: 43119,
                protocol,
                access: "read-write",
              },
            ],
            binaries: [{ path: "/usr/local/bin/node" }, { path: "/usr/bin/node" }],
          },
        },
      });
      const applied: string[] = [];
      const policyPaths: string[] = [];
      const command = vi
        .fn<HostCliClient["command"]>()
        .mockImplementation(async (_command, args = []) => {
          // OpenShell 0.1.3 rejects mixed endpoint and rule updates before gateway access.
          expect(args.includes("--add-endpoint") && args.includes("--add-allow")).toBe(false);
          const responses: Record<string, () => ShellProbeResult> = {
            "sandbox provider": () => successfulProbe(providerName),
            "policy update": () => successfulProbe(),
            "policy get": () => successfulProbe(source),
            "policy set": () => {
              const policyPath = args[args.indexOf("--policy") + 1];
              policyPaths.push(policyPath);
              applied.push(fs.readFileSync(policyPath, "utf8"));
              return successfulProbe();
            },
          };
          return responses[args.slice(0, 2).join(" ")]();
        });
      const host = {
        command,
        openshellCommandPath: "/usr/local/bin/openshell",
      } as unknown as HostCliClient;
      await apply(host);
      expect(applied).toHaveLength(1);
      const policy = parseAndValidateSandboxPolicy(applied[0]);
      expect(policy).toMatchObject({
        network_policies: {
          fixture: {
            endpoints: [
              {
                host: "host.openshell.internal",
                port: 43119,
                protocol,
                credential_binding: { provider: providerName },
                rules: expected.map((method) => ({ allow: { method, path: "/**" } })),
              },
            ],
            binaries: [{ path: "/usr/local/bin/node" }, { path: "/usr/bin/node" }],
          },
        },
      });
      expect(YAML.parse(applied[0]).network_policies.fixture.endpoints[0]).not.toHaveProperty(
        "access",
      );
      expect(policyPaths.every((policyPath) => !fs.existsSync(policyPath))).toBe(true);
    },
  );

  it("strips OpenShell revision metadata before binding the fake Gateway endpoint", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-discord-policy-"));
    tempDirs.push(tempDir);
    const policyFile = path.join(tempDir, "policy.yaml");
    fs.writeFileSync(
      policyFile,
      [
        "Config rev:   15880558010371530494",
        "---",
        "version: 1",
        "network_policies:",
        "  discord_gateway:",
        "    endpoints:",
        "      - host: host.docker.internal",
        "        port: 43117",
        "        protocol: websocket",
        "      - host: discord.com",
        "        port: 443",
        "",
      ].join("\n"),
    );

    const result = runBinding(policyFile);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(YAML.parse(fs.readFileSync(policyFile, "utf8"))).toEqual({
      version: 1,
      network_policies: {
        discord_gateway: {
          endpoints: [
            {
              host: "host.docker.internal",
              port: 43117,
              protocol: "websocket",
              credential_binding: { provider: "e2e-hermes-discord-discord-bridge" },
            },
            { host: "discord.com", port: 443 },
          ],
        },
      },
    });
    expect(fs.statSync(policyFile).mode & 0o777).toBe(0o600);
  });

  it("rejects a missing protocol before choosing among shared endpoints (#10155)", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-messaging-policy-"));
    tempDirs.push(tempDir);
    const policyFile = path.join(tempDir, "policy.yaml");
    fs.writeFileSync(policyFile, "version: 1\nnetwork_policies: {}\n");

    const result = spawnSync(
      process.execPath,
      [
        "--disable-warning=DEP0205",
        "--import",
        "tsx",
        HELPER,
        policyFile,
        "e2e-hermes-discord-discord-bridge",
        "host.docker.internal",
        "43117",
      ],
      { encoding: "utf8", killSignal: "SIGKILL", timeout: 15_000 },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("<protocol>");
  });

  it("binds only the requested protocol when a fake host and port are shared", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-messaging-policy-"));
    tempDirs.push(tempDir);
    const policyFile = path.join(tempDir, "policy.yaml");
    fs.writeFileSync(
      policyFile,
      [
        "version: 1",
        "network_policies:",
        "  fake:",
        "    endpoints:",
        "      - host: host.docker.internal",
        "        port: 43117",
        "        protocol: rest",
        "      - host: host.docker.internal",
        "        port: 43117",
        "        protocol: websocket",
        "",
      ].join("\n"),
    );

    const result = runBinding(policyFile, "websocket");
    const endpoints = YAML.parse(fs.readFileSync(policyFile, "utf8")).network_policies.fake
      .endpoints as Array<Record<string, unknown>>;

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(endpoints[0]).not.toHaveProperty("credential_binding");
    expect(endpoints[1]).toHaveProperty("credential_binding", {
      provider: "e2e-hermes-discord-discord-bridge",
    });
  });

  it("temporarily unbinds only the selected provider before attachment refresh", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-unbind-policy-"));
    tempDirs.push(tempDir);
    const policyFile = path.join(tempDir, "policy.yaml");
    fs.writeFileSync(
      policyFile,
      YAML.stringify({
        version: 1,
        network_policies: {
          fake: {
            endpoints: [
              {
                host: "discord.com",
                port: 443,
                credential_binding: { provider: "e2e-hermes-discord-discord-bridge" },
              },
              {
                host: "example.com",
                port: 443,
                credential_binding: { provider: "another-provider" },
              },
            ],
          },
        },
      }),
    );

    const result = runUnbind(policyFile);
    const endpoints = YAML.parse(fs.readFileSync(policyFile, "utf8")).network_policies.fake
      .endpoints as Array<Record<string, unknown>>;

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(endpoints[0]).not.toHaveProperty("credential_binding");
    expect(endpoints[1]).toHaveProperty("credential_binding", {
      provider: "another-provider",
    });
  });

  it("reattaches one provider without advancing its credential generation", async () => {
    const providerName = "e2e-hermes-discord-discord-bridge";
    const originalPolicy = {
      version: 1,
      network_policies: {
        discord: {
          endpoints: [
            {
              host: "discord.com",
              port: 443,
              credential_binding: { provider: providerName },
            },
            {
              host: "host.openshell.internal",
              port: 43117,
              protocol: "websocket",
            },
            {
              host: "example.com",
              port: 443,
              credential_binding: { provider: "another-provider" },
            },
          ],
        },
      },
    };
    const appliedPolicies: (typeof originalPolicy)[] = [];
    const recordAppliedPolicy = (args: string[]) => {
      const file = args.at(args.indexOf("--policy") + 1);
      expect(file).toBeTruthy();
      appliedPolicies.push(YAML.parse(fs.readFileSync(file!, "utf8")) as typeof originalPolicy);
      return Promise.resolve(successfulProbe());
    };
    const command = vi
      .fn<HostCliClient["command"]>()
      .mockResolvedValueOnce(successfulProbe(providerName))
      .mockResolvedValueOnce(successfulProbe(YAML.stringify(originalPolicy)))
      .mockImplementationOnce(async (_command, args = []) => recordAppliedPolicy(args));
    const host = {
      command,
      openshellCommandPath: "/usr/local/bin/openshell",
    } as unknown as HostCliClient;

    await rebindFixtureProviderPolicyEndpoint(host, "e2e-hermes-discord", {
      artifactName: "hermes-discord-rebind",
      credentialEnv: "DISCORD_BOT_TOKEN",
      endpoint: {
        host: "host.openshell.internal",
        port: 43117,
        protocol: "websocket",
      },
      env: {
        DISCORD_BOT_TOKEN: "test-fixture-token",
        OPENSHELL_GATEWAY: "nemoclaw",
      },
      providerName,
      redactionValues: ["test-fixture-token"],
    });

    expect(command.mock.calls.map(([, args]) => args)).toEqual([
      ["sandbox", "provider", "list", "-g", "nemoclaw", "e2e-hermes-discord"],
      ["policy", "get", "--base", "e2e-hermes-discord"],
      ["policy", "set", "--policy", expect.any(String), "--wait", "e2e-hermes-discord"],
    ]);
    expect(appliedPolicies).toHaveLength(1);

    const reboundEndpoints = appliedPolicies[0]!.network_policies.discord.endpoints;
    expect(reboundEndpoints[0]).toHaveProperty("credential_binding", { provider: providerName });
    expect(reboundEndpoints[1]).toHaveProperty("credential_binding", { provider: providerName });
    expect(reboundEndpoints[2]).toHaveProperty("credential_binding", {
      provider: "another-provider",
    });
  });

  it("rejects generic Python binaries in the Hermes fake Discord endpoint policy", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-discord-policy-"));
    tempDirs.push(tempDir);
    const policyFile = path.join(tempDir, "policy.yaml");
    fs.writeFileSync(
      policyFile,
      [
        "version: 1",
        "network_policies:",
        "  discord_gateway:",
        "    endpoints:",
        "      - host: host.docker.internal",
        "        port: 43117",
        "        protocol: websocket",
        "    binaries:",
        "      - path: /opt/hermes/.venv/bin/python",
        "      - path: /usr/bin/python3",
        "      - path: /usr/local/bin/python3",
        "      - path: /usr/local/bin/node",
        "",
      ].join("\n"),
    );

    const result = runBinaryAssertion(policyFile);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("/usr/bin/python3");
    expect(result.stderr).toContain("/usr/local/bin/python3");
    expect(result.stderr).toContain("/usr/local/bin/node");
  });

  it("accepts only the Hermes venv interpreter for the fake Discord endpoint", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-discord-policy-"));
    tempDirs.push(tempDir);
    const policyFile = path.join(tempDir, "policy.yaml");
    fs.writeFileSync(
      policyFile,
      [
        "version: 1",
        "network_policies:",
        "  discord_gateway:",
        "    endpoints:",
        "      - host: host.docker.internal",
        "        port: 43117",
        "        protocol: websocket",
        "    binaries:",
        "      - path: /opt/hermes/.venv/bin/python",
        "",
      ].join("\n"),
    );

    const result = runBinaryAssertion(policyFile);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
