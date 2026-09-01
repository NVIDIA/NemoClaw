// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import { rebindFixtureProviderPolicyEndpoint } from "../fixtures/gateway-providers.ts";
import { requireSuccessfulPolicyBoundaryBuild } from "../fixtures/hermes-discord-policy-boundary-build.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  HERMES_DISCORD_REST_PROOF_SOURCE,
  isDiscordExternalAccessDenial,
  verifyDiscordRestBoundary,
} from "../live/hermes-discord-proxy.ts";

const HELPER = path.resolve(import.meta.dirname, "../fixtures/hermes-discord-policy-binding.ts");
const TYPESCRIPT = path.resolve("node_modules/typescript/bin/tsc");
const POLICY_BOUNDARY_CONFIG = path.resolve("nemoclaw/tsconfig.shared.json");
const tempDirs: string[] = [];

describe("Discord external boundary classification", () => {
  it("isolates the exact edge denial from credential-rewrite failures", () => {
    expect(isDiscordExternalAccessDenial(403, "error code: 1010\n")).toBe(true);
    expect(isDiscordExternalAccessDenial(403, "unresolved credential placeholder")).toBe(false);
    expect(isDiscordExternalAccessDenial(401, "error code: 1010")).toBe(false);
  });

  it("records only exact external unavailability after the local rewrite proof", async () => {
    const recordUnavailable = vi.fn(async () => undefined);
    await expect(
      verifyDiscordRestBoundary(
        '{"statusCode":403,"body":"error code: 1010\\n"}\n',
        recordUnavailable,
      ),
    ).resolves.toBeUndefined();
    expect(recordUnavailable).toHaveBeenCalledWith(
      "Discord edge denied this runner before the API boundary (error 1010)",
    );
    await expect(
      verifyDiscordRestBoundary(
        '{"statusCode":403,"body":"unresolved credential placeholder"}\n',
        recordUnavailable,
      ),
    ).rejects.toThrow("Unexpected Discord users/@me response");
  });
});

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

  it("uses only the fresh revision-scoped exec credential for the REST proof", () => {
    expect(HERMES_DISCORD_REST_PROOF_SOURCE).toContain(
      'token = os.environ.get("DISCORD_BOT_TOKEN", "")',
    );
    expect(HERMES_DISCORD_REST_PROOF_SOURCE).toContain(
      're.fullmatch(r"openshell:resolve:env:v[0-9]{1,20}_DISCORD_BOT_TOKEN", token)',
    );
    expect(HERMES_DISCORD_REST_PROOF_SOURCE).not.toContain("/sandbox/.hermes/.env");
  });

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

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
      .mockResolvedValueOnce(successfulProbe(YAML.stringify(originalPolicy)))
      .mockResolvedValueOnce(successfulProbe(providerName))
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
      ["policy", "get", "--base", "e2e-hermes-discord"],
      ["sandbox", "provider", "list", "-g", "nemoclaw", "e2e-hermes-discord"],
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
        "",
      ].join("\n"),
    );

    const result = runBinaryAssertion(policyFile);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("/usr/bin/python3");
    expect(result.stderr).toContain("/usr/local/bin/python3");
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
