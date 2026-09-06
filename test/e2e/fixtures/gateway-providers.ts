// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resultText } from "./clients/command.ts";
import type { HostCliClient } from "./clients/host.ts";
import type { SandboxClient } from "./clients/sandbox.ts";
import { expect } from "./e2e-test.ts";
import {
  assertFixtureProviderPolicyEndpointBinaries,
  bindFixtureProviderPolicyEndpoint,
} from "./gateway-provider-policy-binding.ts";
import type { ShellProbeResult } from "./shell-probe.ts";

const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const CREDENTIAL_ENV = /^[A-Z_][A-Z0-9_]*$/u;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertProviderName(providerName: string): void {
  if (!PROVIDER_NAME.test(providerName)) {
    throw new Error(`Unsafe OpenShell provider name: ${providerName}`);
  }
}

async function runFixtureOpenShell(
  host: HostCliClient,
  args: string[],
  options: {
    readonly artifactName: string;
    readonly env: NodeJS.ProcessEnv;
    readonly redactionValues: readonly string[];
  },
): Promise<ShellProbeResult> {
  const result = await host.command(host.openshellCommandPath, args, {
    artifactName: options.artifactName,
    env: options.env,
    redactionValues: [...options.redactionValues],
    timeoutMs: 120_000,
  });
  expect(result.exitCode, resultText(result)).toBe(0);
  return result;
}

type FixtureProviderCommandOptions = {
  readonly artifactName: string;
  readonly env: NodeJS.ProcessEnv;
  readonly providerName: string;
  readonly redactionValues: readonly string[];
};

async function requireFixtureProviderAttached(
  host: HostCliClient,
  sandboxName: string,
  options: FixtureProviderCommandOptions,
): Promise<void> {
  const gatewayName = options.env.OPENSHELL_GATEWAY ?? "nemoclaw";
  assertProviderName(gatewayName);
  const attachments = await runFixtureOpenShell(
    host,
    ["sandbox", "provider", "list", "-g", gatewayName, sandboxName],
    options,
  );
  if (!resultText(attachments).split(/\s+/u).includes(options.providerName)) {
    throw new Error(
      `Fixture provider ${options.providerName} is not attached to sandbox ${sandboxName}`,
    );
  }
}

async function setFixtureProviderPolicyBinding(
  host: HostCliClient,
  sandboxName: string,
  options: FixtureProviderCommandOptions & {
    readonly endpoint: {
      readonly host: string;
      readonly port: number;
      readonly protocol: "rest" | "websocket";
    };
    readonly expectedBinaries?: readonly string[];
  },
): Promise<void> {
  const policy = await host.command(
    host.openshellCommandPath,
    ["policy", "get", "--base", sandboxName],
    {
      artifactName: `${options.artifactName}-policy-before-rebind`,
      env: options.env,
      redactionValues: [...options.redactionValues],
      timeoutMs: 60_000,
    },
  );
  expect(policy.exitCode, resultText(policy)).toBe(0);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-provider-rebind-"));
  const boundPolicy = path.join(temporary, "bound-policy.yaml");
  try {
    fs.writeFileSync(boundPolicy, policy.stdout, { mode: 0o600 });
    bindFixtureProviderPolicyEndpoint(
      boundPolicy,
      options.providerName,
      options.endpoint.host,
      options.endpoint.port,
      options.endpoint.protocol,
    );
    if (options.expectedBinaries) {
      assertFixtureProviderPolicyEndpointBinaries(
        boundPolicy,
        options.endpoint.host,
        options.endpoint.port,
        options.endpoint.protocol,
        options.expectedBinaries,
      );
    }
    await runFixtureOpenShell(
      host,
      ["policy", "set", "--policy", boundPolicy, "--wait", sandboxName],
      options,
    );
  } finally {
    fs.rmSync(temporary, { force: true, recursive: true });
  }
}

/** Bind a fixture endpoint without rotating the already-attached provider credential revision. */
export async function rebindFixtureProviderPolicyEndpoint(
  host: HostCliClient,
  sandboxName: string,
  options: {
    readonly artifactName: string;
    readonly credentialEnv: string;
    readonly endpoint: {
      readonly host: string;
      readonly port: number | string;
      readonly protocol: "rest" | "websocket";
    };
    readonly env: NodeJS.ProcessEnv;
    readonly providerName: string;
    readonly redactionValues?: readonly string[];
  },
): Promise<void> {
  assertProviderName(options.providerName);
  if (!CREDENTIAL_ENV.test(options.credentialEnv)) {
    throw new Error(`Unsafe provider credential env name: ${options.credentialEnv}`);
  }
  if (!options.env[options.credentialEnv]) {
    throw new Error(`Missing provider credential env value: ${options.credentialEnv}`);
  }
  const endpointPort = Number(options.endpoint.port);
  if (!Number.isInteger(endpointPort) || endpointPort < 1 || endpointPort > 65_535) {
    throw new Error("Fixture provider endpoint port must be an integer between 1 and 65535.");
  }

  const redactionValues = options.redactionValues ?? [];
  const commandOptions = {
    artifactName: options.artifactName,
    env: options.env,
    providerName: options.providerName,
    redactionValues,
  };
  await requireFixtureProviderAttached(host, sandboxName, {
    ...commandOptions,
    artifactName: `${options.artifactName}-provider-attachments`,
  });
  await setFixtureProviderPolicyBinding(host, sandboxName, {
    ...commandOptions,
    artifactName: `${options.artifactName}-policy-rebound`,
    endpoint: { ...options.endpoint, port: endpointPort },
  });
}

/** Add a fake endpoint only after proving its credential provider is attached. */
export async function applyFixtureProviderPolicyEndpoint(
  host: HostCliClient,
  sandboxName: string,
  options: {
    readonly allowedBinaries?: readonly string[];
    readonly artifactName: string;
    readonly endpoint: { readonly port: number | string };
    readonly env: NodeJS.ProcessEnv;
    readonly protocol: "rest" | "websocket";
    readonly providerName: string;
    readonly redactionValues: readonly string[];
    readonly rewrite: "request-body-credential-rewrite" | "websocket-credential-rewrite";
  },
): Promise<void> {
  assertProviderName(options.providerName);
  const endpointPort = Number(options.endpoint.port);
  if (!Number.isInteger(endpointPort) || endpointPort < 1 || endpointPort > 65_535) {
    throw new Error("Fixture provider endpoint port must be an integer between 1 and 65535.");
  }
  const allowedBinaries = options.allowedBinaries ?? ["/usr/local/bin/node", "/usr/bin/node"];
  const commandOptions = {
    artifactName: options.artifactName,
    env: options.env,
    providerName: options.providerName,
    redactionValues: options.redactionValues,
  };
  await requireFixtureProviderAttached(host, sandboxName, {
    ...commandOptions,
    artifactName: `${options.artifactName}-provider-attachments`,
  });

  const policyHost = "host.openshell.internal";
  const methods = options.protocol === "rest" ? ["GET", "POST"] : ["GET", "WEBSOCKET_TEXT"];
  const args = [
    "policy",
    "update",
    sandboxName,
    "--add-endpoint",
    `${policyHost}:${String(endpointPort)}:read-write:${options.protocol}:enforce:${options.rewrite},allowed-ip=10.0.0.0/8,allowed-ip=172.16.0.0/12,allowed-ip=192.168.0.0/16`,
  ];
  for (const method of methods)
    args.push("--add-allow", `${policyHost}:${String(endpointPort)}:${method}:/**`);
  args.push(...allowedBinaries.flatMap((binary) => ["--binary", binary]), "--wait");
  await runFixtureOpenShell(host, args, commandOptions);
  await setFixtureProviderPolicyBinding(host, sandboxName, {
    ...commandOptions,
    artifactName: `${options.artifactName}-credential-binding`,
    endpoint: { host: policyHost, port: endpointPort, protocol: options.protocol },
    expectedBinaries: allowedBinaries,
  });
}

export async function upsertGenericGatewayProvider(
  host: HostCliClient,
  providerName: string,
  options: {
    artifactName: string;
    credentialEnv: string;
    env: NodeJS.ProcessEnv;
    redactionValues?: string[];
  },
): Promise<void> {
  assertProviderName(providerName);
  if (!CREDENTIAL_ENV.test(options.credentialEnv)) {
    throw new Error(`Unsafe provider credential env name: ${options.credentialEnv}`);
  }
  if (!options.env[options.credentialEnv]) {
    throw new Error(`Missing provider credential env value: ${options.credentialEnv}`);
  }

  const provider = shellQuote(providerName);
  const credential = shellQuote(options.credentialEnv);
  const result = await host.command(
    "bash",
    [
      "-lc",
      [
        "set -euo pipefail",
        `if openshell provider get -g nemoclaw ${provider} >/dev/null 2>&1; then`,
        `  openshell provider update -g nemoclaw ${provider} --credential ${credential}`,
        "else",
        `  openshell provider create -g nemoclaw --name ${provider} --type generic --credential ${credential}`,
        "fi",
      ].join("\n"),
    ],
    {
      artifactName: options.artifactName,
      env: options.env,
      redactionValues: options.redactionValues ?? [],
      timeoutMs: 60_000,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
}

export async function expectSandboxProviderAttachment(
  sandbox: SandboxClient,
  sandboxName: string,
  providerName: string,
  expected: "present" | "absent",
  options: { artifactName: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  assertProviderName(providerName);
  const attachments = await sandbox.openshell(
    ["sandbox", "provider", "list", "-g", "nemoclaw", sandboxName],
    {
      artifactName: options.artifactName,
      env: options.env,
      timeoutMs: 60_000,
    },
  );
  expect(attachments.exitCode, resultText(attachments)).toBe(0);
  const providerNames = resultText(attachments).split(/\s+/u);
  if (expected === "present") {
    expect(providerNames).toContain(providerName);
  } else {
    expect(providerNames).not.toContain(providerName);
  }
}
