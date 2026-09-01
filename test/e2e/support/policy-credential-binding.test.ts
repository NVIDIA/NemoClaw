// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";

import type { HostCliClient } from "../fixtures/clients/host.ts";
import { requireSuccessfulPolicyBoundaryBuild } from "../fixtures/hermes-discord-policy-boundary-build.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../fixtures/shell-probe.ts";
import { applyPolicyCredentialBinding } from "../live/policy-credential-binding.ts";

const HELPER = path.resolve(import.meta.dirname, "../fixtures/policy-credential-binding.ts");
const TYPESCRIPT = path.resolve("node_modules/typescript/bin/tsc");
const POLICY_BOUNDARY_CONFIG = path.resolve("nemoclaw/tsconfig.shared.json");
const tempDirs: string[] = [];

function localCommandHost(
  openshellCommandPath: string,
): Pick<HostCliClient, "command" | "openshellCommandPath"> {
  return {
    openshellCommandPath,
    async command(
      command: string,
      args: string[] = [],
      options: ShellProbeRunOptions = {},
    ): Promise<ShellProbeResult> {
      const result = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        env: { ...process.env, ...options.env },
        killSignal: "SIGKILL",
        timeout: options.timeoutMs,
      });
      return {
        command: [command, ...args],
        exitCode: result.status,
        signal: result.signal,
        timedOut: false,
        stdout: result.stdout ?? "",
        stderr: [result.stderr, result.error?.message].filter(Boolean).join("\n"),
        artifacts: { stdout: "", stderr: "", result: "" },
      };
    },
  };
}

function fakeOpenShell(
  policy: string,
  overrides: {
    postRecheckConcurrentPolicy?: string;
    readbackPolicy?: string;
    recheckPolicy?: string;
  } = {},
): {
  appliedPolicy: string;
  callsFile: string;
  env: NodeJS.ProcessEnv;
  executable: string;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-transaction-"));
  tempDirs.push(tempDir);
  const executable = path.join(tempDir, "openshell");
  const basePolicy = path.join(tempDir, "base-policy.yaml");
  const appliedPolicy = path.join(tempDir, "applied-policy.yaml");
  const callsFile = path.join(tempDir, "calls");
  const policyVersion = path.join(tempDir, "policy-version");
  const readbackPolicy = path.join(tempDir, "readback-policy.yaml");
  const recheckPolicy = path.join(tempDir, "recheck-policy.yaml");
  const concurrentPolicy = path.join(tempDir, "concurrent-policy.yaml");
  const policyRevisions = path.join(tempDir, "revisions");
  fs.writeFileSync(basePolicy, policy);
  fs.writeFileSync(policyVersion, "1\n");
  fs.writeFileSync(readbackPolicy, overrides.readbackPolicy ?? policy);
  fs.writeFileSync(recheckPolicy, overrides.recheckPolicy ?? policy);
  fs.writeFileSync(concurrentPolicy, overrides.postRecheckConcurrentPolicy ?? policy);
  fs.mkdirSync(policyRevisions);
  fs.writeFileSync(path.join(policyRevisions, "1"), policy);
  fs.writeFileSync(
    executable,
    [
      "#!/usr/bin/env bash",
      "set -eu",
      'case "${1-}:${2-}" in',
      "  policy:get)",
      '    case " $* " in',
      '      *" --full "*)',
      `        printf 'metadata\\n' >>"$FAKE_OPENSHELL_CALLS"`,
      `        version=$(cat "$FAKE_OPENSHELL_POLICY_VERSION")`,
      '        sandbox="${!#}"',
      `        printf '{"scope":"sandbox","sandbox":"%s","status":"effective","policy_source":"sandbox","policy":{},"hash":"sha256:fake-%s","active_version":%s}\\n' "$sandbox" "$version" "$version"`,
      "        ;;",
      '      *" --rev "*)',
      `        printf 'revision\\n' >>"$FAKE_OPENSHELL_CALLS"`,
      `        revision="$4"`,
      `        cat "$FAKE_OPENSHELL_POLICY_REVISIONS/$revision"`,
      "        ;;",
      "      *)",
      `        printf 'get\\n' >>"$FAKE_OPENSHELL_CALLS"`,
      `        get_count=$(grep -c '^get$' "$FAKE_OPENSHELL_CALLS")`,
      `        case "$get_count" in`,
      `          1) source="$FAKE_OPENSHELL_BASE_POLICY" ;;`,
      '          2) source="${FAKE_OPENSHELL_RECHECK_POLICY:-$FAKE_OPENSHELL_BASE_POLICY}" ;;',
      '          3) source="${FAKE_OPENSHELL_READBACK_POLICY:-$FAKE_OPENSHELL_APPLIED_POLICY}" ;;',
      '          *) source="${FAKE_OPENSHELL_APPLIED_POLICY:-$FAKE_OPENSHELL_BASE_POLICY}" ;;',
      `        esac`,
      `        cat "$source"`,
      "        ;;",
      "    esac",
      "    ;;",
      "  policy:set)",
      `    printf 'set\\n' >>"$FAKE_OPENSHELL_CALLS"`,
      `    version=$(cat "$FAKE_OPENSHELL_POLICY_VERSION")`,
      '    case "${FAKE_OPENSHELL_CONCURRENT_POLICY-}:$version" in',
      "      ?*:1)",
      `        version=2`,
      `        cp "$FAKE_OPENSHELL_CONCURRENT_POLICY" "$FAKE_OPENSHELL_POLICY_REVISIONS/$version"`,
      "        ;;",
      "    esac",
      `    version=$((version + 1))`,
      `    cp "$4" "$FAKE_OPENSHELL_APPLIED_POLICY"`,
      `    cp "$4" "$FAKE_OPENSHELL_POLICY_REVISIONS/$version"`,
      `    printf '%s\\n' "$version" >"$FAKE_OPENSHELL_POLICY_VERSION"`,
      "    ;;",
      "  *)",
      "    exit 64",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  return {
    appliedPolicy,
    callsFile,
    env: {
      FAKE_OPENSHELL_APPLIED_POLICY: appliedPolicy,
      FAKE_OPENSHELL_BASE_POLICY: basePolicy,
      FAKE_OPENSHELL_CALLS: callsFile,
      FAKE_OPENSHELL_POLICY_REVISIONS: policyRevisions,
      FAKE_OPENSHELL_POLICY_VERSION: policyVersion,
      ...(overrides.postRecheckConcurrentPolicy
        ? { FAKE_OPENSHELL_CONCURRENT_POLICY: concurrentPolicy }
        : {}),
      ...(overrides.readbackPolicy ? { FAKE_OPENSHELL_READBACK_POLICY: readbackPolicy } : {}),
      ...(overrides.recheckPolicy ? { FAKE_OPENSHELL_RECHECK_POLICY: recheckPolicy } : {}),
    },
    executable,
  };
}

function endpointPolicy(protocols: string[]): string {
  return [
    "version: 1",
    "network_policies:",
    "  fake:",
    "    endpoints:",
    ...protocols.flatMap((protocol) => [
      "      - host: host.docker.internal",
      "        port: 43117",
      `        protocol: ${protocol}`,
    ]),
    "",
  ].join("\n");
}

function endpointPolicyWithConcurrentEntry(): string {
  const policy = YAML.parse(endpointPolicy(["rest", "websocket"]));
  policy.network_policies.concurrent_host_edit = {
    endpoints: [{ host: "concurrent.example.com", port: 443 }],
  };
  return YAML.stringify(policy);
}

function endpointPolicyWithConflictingBinding(): string {
  const policy = YAML.parse(endpointPolicy(["rest", "websocket"]));
  policy.network_policies.fake.endpoints[0].credential_binding = {
    provider: "external-policy-provider",
  };
  return YAML.stringify(policy);
}

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

describe("binds a credential to exactly one policy endpoint", () => {
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

  it("rejects duplicate endpoint ownership across network policies", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-messaging-policy-"));
    tempDirs.push(tempDir);
    const policyFile = path.join(tempDir, "policy.yaml");
    const source = [
      "version: 1",
      "network_policies:",
      "  first:",
      "    endpoints:",
      "      - host: host.docker.internal",
      "        port: 43117",
      "        protocol: websocket",
      "  second:",
      "    endpoints:",
      "      - host: host.docker.internal",
      "        port: 43117",
      "        protocol: websocket",
      "",
    ].join("\n");
    fs.writeFileSync(policyFile, source);

    const result = runBinding(policyFile);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "fake endpoint host.docker.internal:43117/websocket matches 2 base policy entries; expected exactly one",
    );
    expect(fs.readFileSync(policyFile, "utf8")).toBe(source);
  });

  it.each(["rest", "websocket"] as const)(
    "binds only the %s endpoint when REST and WebSocket share a host and port",
    async (protocol) => {
      const fake = fakeOpenShell(endpointPolicy(["rest", "websocket"]));

      await applyPolicyCredentialBinding({
        host: localCommandHost(fake.executable),
        sandboxName: "e2e-policy-transaction",
        providerName: "e2e-policy-provider",
        endpointHost: "host.docker.internal",
        endpointPort: 43117,
        protocol,
        env: fake.env,
        redactionValues: [],
        artifactName: `bind-${protocol}-policy-credential`,
      });

      expect(fs.readFileSync(fake.callsFile, "utf8").trim().split("\n")).toEqual([
        "metadata",
        "get",
        "get",
        "set",
        "metadata",
        "get",
      ]);
      const endpoints = YAML.parse(fs.readFileSync(fake.appliedPolicy, "utf8")).network_policies
        .fake.endpoints as Array<Record<string, unknown>>;
      expect(endpoints.find((endpoint) => endpoint.protocol === protocol)).toHaveProperty(
        "credential_binding",
        { provider: "e2e-policy-provider" },
      );
      expect(endpoints.find((endpoint) => endpoint.protocol !== protocol)).not.toHaveProperty(
        "credential_binding",
      );
    },
  );

  it("does not set a policy when the shared transaction finds ambiguous endpoint ownership", async () => {
    const fake = fakeOpenShell(endpointPolicy(["rest", "rest"]));

    await expect(
      applyPolicyCredentialBinding({
        host: localCommandHost(fake.executable),
        sandboxName: "e2e-policy-transaction",
        providerName: "e2e-policy-provider",
        endpointHost: "host.docker.internal",
        endpointPort: 43117,
        protocol: "rest",
        env: fake.env,
        redactionValues: [],
        artifactName: "bind-ambiguous-policy-credential",
      }),
    ).rejects.toThrow("matches 2 base policy entries; expected exactly one");

    expect(fs.readFileSync(fake.callsFile, "utf8").trim().split("\n")).toEqual(["metadata", "get"]);
    expect(fs.existsSync(fake.appliedPolicy)).toBe(false);
  });

  it("does not set a policy when the sandbox base changes during credential binding", async () => {
    const fake = fakeOpenShell(endpointPolicy(["rest", "websocket"]), {
      recheckPolicy: endpointPolicy(["rest"]),
    });

    await expect(
      applyPolicyCredentialBinding({
        host: localCommandHost(fake.executable),
        sandboxName: "e2e-policy-transaction",
        providerName: "e2e-policy-provider",
        endpointHost: "host.docker.internal",
        endpointPort: 43117,
        protocol: "rest",
        env: fake.env,
        redactionValues: [],
        artifactName: "bind-concurrently-changed-policy-credential",
      }),
    ).rejects.toThrow("sandbox base policy changed while preparing the credential binding");

    expect(fs.readFileSync(fake.callsFile, "utf8").trim().split("\n")).toEqual([
      "metadata",
      "get",
      "get",
    ]);
    expect(fs.existsSync(fake.appliedPolicy)).toBe(false);
  });

  it("fails when policy readback does not contain the requested credential binding", async () => {
    const fake = fakeOpenShell(endpointPolicy(["rest", "websocket"]), {
      readbackPolicy: endpointPolicy(["rest", "websocket"]),
    });

    await expect(
      applyPolicyCredentialBinding({
        host: localCommandHost(fake.executable),
        sandboxName: "e2e-policy-transaction",
        providerName: "e2e-policy-provider",
        endpointHost: "host.docker.internal",
        endpointPort: 43117,
        protocol: "rest",
        env: fake.env,
        redactionValues: [],
        artifactName: "bind-mismatched-policy-readback",
      }),
    ).rejects.toThrow("applied policy did not match the requested credential binding");

    expect(fs.readFileSync(fake.callsFile, "utf8").trim().split("\n")).toEqual([
      "metadata",
      "get",
      "get",
      "set",
      "metadata",
      "get",
    ]);
  });

  it("preserves an unrelated policy edit that races the final recheck and policy set", async () => {
    const fake = fakeOpenShell(endpointPolicy(["rest", "websocket"]), {
      postRecheckConcurrentPolicy: endpointPolicyWithConcurrentEntry(),
    });

    await applyPolicyCredentialBinding({
      host: localCommandHost(fake.executable),
      sandboxName: "e2e-policy-transaction",
      providerName: "e2e-policy-provider",
      endpointHost: "host.docker.internal",
      endpointPort: 43117,
      protocol: "rest",
      env: fake.env,
      redactionValues: [],
      artifactName: "bind-policy-after-concurrent-edit",
    });

    const applied = YAML.parse(fs.readFileSync(fake.appliedPolicy, "utf8"));
    expect(applied.network_policies).toHaveProperty("concurrent_host_edit");
    expect(applied.network_policies.fake.endpoints[0]).toHaveProperty("credential_binding", {
      provider: "e2e-policy-provider",
    });
    expect(fs.readFileSync(fake.callsFile, "utf8").trim().split("\n")).toEqual([
      "metadata",
      "get",
      "get",
      "set",
      "metadata",
      "get",
      "revision",
      "get",
      "set",
      "metadata",
      "get",
    ]);
  });

  it("restores a conflicting policy edit that races the final recheck and fails closed", async () => {
    const fake = fakeOpenShell(endpointPolicy(["rest", "websocket"]), {
      postRecheckConcurrentPolicy: endpointPolicyWithConflictingBinding(),
    });

    await expect(
      applyPolicyCredentialBinding({
        host: localCommandHost(fake.executable),
        sandboxName: "e2e-policy-transaction",
        providerName: "e2e-policy-provider",
        endpointHost: "host.docker.internal",
        endpointPort: 43117,
        protocol: "rest",
        env: fake.env,
        redactionValues: [],
        artifactName: "reject-conflicting-concurrent-policy-binding",
      }),
    ).rejects.toThrow("restored the external policy and refused the conflicting binding");

    const applied = YAML.parse(fs.readFileSync(fake.appliedPolicy, "utf8"));
    expect(applied.network_policies.fake.endpoints[0]).toHaveProperty("credential_binding", {
      provider: "external-policy-provider",
    });
  });
});
