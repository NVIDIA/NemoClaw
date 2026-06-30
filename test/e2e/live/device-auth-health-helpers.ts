// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { resultText } from "../fixtures/clients/index.ts";
import {
  type SandboxClient,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { isTransientProviderValidationFailure } from "./network-policy-transient-provider.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
export const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-health-auth";
validateSandboxName(SANDBOX_NAME);
export const DASHBOARD_PORT = process.env.NEMOCLAW_DASHBOARD_PORT ?? "18789";
const INSTALL_ATTEMPTS = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" ? 3 : 1;

export function commandEnv(apiKey?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_DASHBOARD_PORT: DASHBOARD_PORT,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
  apiKey && Object.assign(env, { NVIDIA_INFERENCE_API_KEY: apiKey });
  return env;
}

export async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Best-effort cleanup/recovery probes should not hide primary failures.
  }
}

export function assertDockerAvailable(
  result: ShellProbeResult,
  skip: (note?: string) => never,
): void {
  result.exitCode === 0 || process.env.GITHUB_ACTIONS === "true"
    ? undefined
    : skip(`Docker is required for device auth health E2E: ${resultText(result)}`);
  result.exitCode === 0 ||
    process.env.GITHUB_ACTIONS !== "true" ||
    (() => {
      throw new Error(`Docker is required for device auth health E2E: ${resultText(result)}`);
    })();
}

export async function httpCodeFromSandbox(
  sandbox: SandboxClient,
  urlPath: string,
  artifactName: string,
): Promise<ShellProbeResult> {
  return await sandbox.execShell(
    SANDBOX_NAME,
    trustedSandboxShellScript(
      `curl -so /dev/null -w '%{http_code}' --max-time 3 http://localhost:${DASHBOARD_PORT}${urlPath}`,
    ),
    {
      artifactName,
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
}

export async function cleanupDeviceAuthSandbox(
  host: HostCliClient,
  sandbox: SandboxClient,
): Promise<void> {
  await bestEffort(() =>
    host.nemoclaw([SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "cleanup-nemoclaw-destroy-device-auth-health",
      env: commandEnv(),
      timeoutMs: 120_000,
    }),
  );
  await bestEffort(() =>
    sandbox.openshell(["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-delete-device-auth-health",
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
}

export async function installDeviceAuthSandbox(
  host: HostCliClient,
  apiKey: string,
  installLog: string,
): Promise<ShellProbeResult> {
  let install: ShellProbeResult | undefined;
  for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
    install = await host.command("bash", ["install.sh", "--non-interactive"], {
      artifactName:
        attempt === 1
          ? "phase-1-install-device-auth-health"
          : `phase-1-install-device-auth-health-attempt-${attempt}`,
      cwd: REPO_ROOT,
      env: commandEnv(apiKey),
      redactionValues: [apiKey],
      timeoutMs: 20 * 60_000,
    });
    fs.writeFileSync(installLog, resultText(install));
    const shouldRetry =
      install.exitCode !== 0 &&
      isTransientProviderValidationFailure(install) &&
      attempt < INSTALL_ATTEMPTS;
    install.exitCode === 0 && (attempt = INSTALL_ATTEMPTS + 1);
    shouldRetry && (await new Promise((resolve) => setTimeout(resolve, 10_000 * attempt)));
    !shouldRetry && install.exitCode !== 0 && (attempt = INSTALL_ATTEMPTS + 1);
  }
  if (!install) throw new Error("install command did not run");
  return install;
}

export async function maybeWriteHostHealthExpectation(
  hostHealth: ShellProbeResult,
  expectCode: (codes: string[], message: string, actual: string) => void,
): Promise<void> {
  const code = hostHealth.stdout.trim();
  code &&
    code !== "000" &&
    expectCode(["200", "401"], `host dashboard health returned ${code}`, code);
}

export async function waitForRecoveryArtifact(
  artifacts: { writeJson(path: string, value: unknown): Promise<string> },
  sandbox: SandboxClient,
): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const recoveredHealth = await httpCodeFromSandbox(
      sandbox,
      "/health",
      `phase-5-recovery-health-code-attempt-${attempt}`,
    );
    const code = recoveredHealth.stdout.trim();
    const recovered = code === "200" || code === "401";
    recovered && (await artifacts.writeJson("gateway-recovered.json", { attempt, code }));
    if (recovered) return;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  await artifacts.writeJson("gateway-recovery-inconclusive.json", {
    reason: "Gateway did not recover within 150s; former shell treated this as optional.",
  });
}
