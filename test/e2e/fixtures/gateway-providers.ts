// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resultText } from "./clients/command.ts";
import type { HostCliClient } from "./clients/host.ts";
import type { SandboxClient } from "./clients/sandbox.ts";
import { expect } from "./e2e-test.ts";

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
