// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { resultText } from "../fixtures/clients/command.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { redactString } from "../fixtures/redaction.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

export const DEFAULT_SPARK_INSTALL_SANDBOX_NAME = "e2e-spark-install-vitest";
export const DEFAULT_INSTALL_URL = "https://www.nvidia.com/nemoclaw.sh";

export type InstallerInvocation = {
  mode: "local" | "public";
  script: string;
  installUrl?: string;
};

type InstallerInvocationOptions = {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
};

function fail(message: string): never {
  throw new Error(message);
}

function requireSparkInstallContract(condition: boolean, message: string): void {
  condition || fail(message);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function assertSparkInstallSandboxName(name: string): string {
  validateSandboxName(name);
  requireSparkInstallContract(
    name.startsWith("e2e-spark-install-"),
    `spark install sandbox must use the e2e-spark-install- prefix: ${name}`,
  );
  return name;
}

export function assertRequiredInstallerEnv(env: NodeJS.ProcessEnv): void {
  requireSparkInstallContract(
    env.NEMOCLAW_NON_INTERACTIVE === "1",
    "NEMOCLAW_NON_INTERACTIVE=1 is required for the Spark install migration",
  );
  requireSparkInstallContract(
    env.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE === "1",
    "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required for the Spark install migration",
  );
}

export function validatePublicInstallUrl(raw: string): string {
  const url = new URL(raw);
  const hostname = url.hostname.toLowerCase();
  requireSparkInstallContract(url.protocol === "https:", "public installer URL must use https");
  requireSparkInstallContract(
    url.username === "" && url.password === "",
    "public installer URL must not include credentials",
  );
  requireSparkInstallContract(
    hostname === "www.nvidia.com",
    `public installer URL host is not allowed: ${url.hostname}`,
  );
  requireSparkInstallContract(
    url.pathname === "/nemoclaw.sh",
    `public installer URL path is not allowed: ${url.pathname}`,
  );
  requireSparkInstallContract(
    url.search === "" && url.hash === "",
    "public installer URL must not include query or fragment data",
  );
  return url.toString();
}

export function buildInstallerInvocation({
  repoRoot,
  env = process.env,
}: InstallerInvocationOptions): InstallerInvocation {
  return env.NEMOCLAW_E2E_PUBLIC_INSTALL === "1"
    ? (() => {
        const installUrl = validatePublicInstallUrl(
          env.NEMOCLAW_INSTALL_SCRIPT_URL ?? DEFAULT_INSTALL_URL,
        );
        return {
          mode: "public" as const,
          installUrl,
          script: [
            "set -euo pipefail",
            "&&",
            `curl -fsSL ${shellQuote(installUrl)}`,
            "|",
            "NEMOCLAW_NON_INTERACTIVE=1",
            "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1",
            "bash",
          ].join(" "),
        };
      })()
    : {
        mode: "local",
        script: [
          `cd ${shellQuote(repoRoot)}`,
          "&&",
          "NEMOCLAW_NON_INTERACTIVE=1",
          "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1",
          "bash install.sh --non-interactive",
        ].join(" "),
      };
}

export function writeRedactedInstallLog(
  file: string,
  result: Pick<ShellProbeResult, "stdout" | "stderr">,
  redactionValues: readonly string[] = [],
): void {
  fs.writeFileSync(file, redactString(resultText(result), redactionValues));
}

export function logTail(
  file: string,
  lineCount = 80,
  redactionValues: readonly string[] = [],
): string {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  return redactString(lines.slice(-lineCount).join("\n"), redactionValues);
}

export function exitDetail(
  result: Pick<ShellProbeResult, "stdout" | "stderr">,
  installLog?: string,
  redactionValues: readonly string[] = [],
): string {
  return [
    redactString(resultText(result), redactionValues),
    installLog
      ? `--- install log tail (${installLog}) ---\n${logTail(installLog, 80, redactionValues)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
