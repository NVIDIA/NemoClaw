// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Live Vitest replacement for test/e2e/test-cloud-onboard-e2e.sh. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { type HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-cloud-onboard-vitest";
const CHECKS_DIR = path.join(REPO_ROOT, "test/e2e/e2e-cloud-experimental/checks");
const LIVE_TIMEOUT_MS = 60 * 60_000;
const liveTest = shouldRunLiveE2EScenarios() ? test : test.skip;

validateSandboxName(SANDBOX_NAME);

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${process.env.PATH ?? ""}`,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_POLICY_MODE: "custom",
    NEMOCLAW_POLICY_PRESETS: "npm,pypi",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
  };
}

function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

async function cleanup(
  host: HostCliClient,
  sandbox: SandboxClient,
  options: { verify: boolean; label: string },
): Promise<void> {
  const args = [path.join(REPO_ROOT, "test/e2e/e2e-cloud-experimental/cleanup.sh")];
  if (options.verify) args.push("--verify");
  const cleanupResult = await host.command("bash", args, {
    artifactName: `${options.label}-cloud-experimental-cleanup`,
    env: env(),
    timeoutMs: 180_000,
  });
  if (options.verify) {
    expect(cleanupResult.exitCode, resultText(cleanupResult)).toBe(0);
  }

  const gatewayDestroy = await sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
    artifactName: `${options.label}-openshell-gateway-destroy`,
    env: env(),
    timeoutMs: 60_000,
  });
  if (options.verify && gatewayDestroy.exitCode !== 0) {
    expect(resultText(gatewayDestroy)).toMatch(
      /unrecognized subcommand|not found|No active gateway/i,
    );
  }
}

function publicInstallRef(): string {
  return process.env.NEMOCLAW_PUBLIC_INSTALL_REF || process.env.GITHUB_SHA || "main";
}

liveTest(
  "cloud onboard: public installer creates healthy sandbox with security checks",
  { timeout: LIVE_TIMEOUT_MS },
  async ({ artifacts, cleanup: cleanupRegistry, host, sandbox, secrets, skip }) => {
    const hosted = requireHostedInferenceConfig(secrets);
    const ref = publicInstallRef();
    const installUrl =
      process.env.NEMOCLAW_INSTALL_SCRIPT_URL ??
      `https://raw.githubusercontent.com/NVIDIA/NemoClaw/${ref}/install.sh`;
    const installCwd = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-public-install-"));
    const redactionValues = [hosted.apiKey];

    await artifacts.writeJson("scenario.json", {
      id: "cloud-onboard",
      legacySource: "test/e2e/test-cloud-onboard-e2e.sh",
      sandboxName: SANDBOX_NAME,
      installUrl,
      installRef: ref,
      checksDir: CHECKS_DIR,
      contracts: [
        "public curl installer uses GitHub clone path for the requested ref",
        "sandbox appears healthy after cloud onboarding",
        "cloud split checks cover inference.local, security leak checks, and Landlock/read-only behavior",
        "cleanup verifies sandbox removal",
      ],
    });

    const docker = await host.command("docker", ["info"], {
      artifactName: "phase-0-docker-info",
      env: env(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") throw new Error(resultText(docker));
      skip(`Docker is required: ${resultText(docker)}`);
    }

    cleanupRegistry.add("remove cloud-onboard sandbox", () =>
      cleanup(host, sandbox, { label: "cleanup", verify: true }),
    );
    await cleanup(host, sandbox, { label: "pre-cleanup", verify: false });

    const install = await host.command(
      "bash",
      ["-lc", `cd '${installCwd}' && curl -fsSL '${installUrl}' | bash`],
      {
        artifactName: "phase-1-public-install",
        env: env({
          ...hosted.env,
          NVIDIA_INFERENCE_API_KEY: hosted.apiKey,
          NEMOCLAW_INSTALL_REF: ref,
          NEMOCLAW_INSTALL_TAG: ref,
          NEMOCLAW_INSTALL_SCRIPT_URL: installUrl,
        }),
        redactionValues,
        timeoutMs: 25 * 60_000,
      },
    );
    expect(install.exitCode, resultText(install)).toBe(0);
    expect(resultText(install)).toContain("Installing NemoClaw from GitHub");
    expect(resultText(install)).toContain("Cloning NemoClaw source");
    if (ref !== "main") expect(resultText(install)).toContain(`Resolved install ref: ${ref}`);

    const cliProbe = await host.command(
      "bash",
      [
        "-lc",
        'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; command -v nemoclaw; command -v openshell; nemoclaw --help >/dev/null',
      ],
      { artifactName: "phase-2-cli-path-probe", env: env(), timeoutMs: 60_000 },
    );
    expect(cliProbe.exitCode, resultText(cliProbe)).toBe(0);

    const list = await host.command("bash", ["-lc", "nemoclaw list"], {
      artifactName: "phase-2-nemoclaw-list",
      env: env(),
      timeoutMs: 60_000,
    });
    expect(list.exitCode, resultText(list)).toBe(0);
    expect(list.stdout).toContain(SANDBOX_NAME);

    const checkScripts = fs
      .readdirSync(CHECKS_DIR)
      .filter((name) => name.endsWith(".sh"))
      .sort();
    expect(checkScripts.length).toBeGreaterThan(0);
    for (const scriptName of checkScripts) {
      const result = await host.command("bash", [path.join(CHECKS_DIR, scriptName)], {
        artifactName: `phase-3-check-${scriptName.replace(/\.sh$/, "")}`,
        cwd: REPO_ROOT,
        env: env({
          ...hosted.env,
          CLOUD_EXPERIMENTAL_MODEL: hosted.model,
          COMPATIBLE_API_KEY: hosted.apiKey,
          NEMOCLAW_E2E_CLOUD_API_KEY_ENV: "COMPATIBLE_API_KEY",
          REPO: REPO_ROOT,
          SANDBOX_NAME,
        }),
        redactionValues,
        timeoutMs: 180_000,
      });
      expect(result.exitCode, `${scriptName}: ${resultText(result)}`).toBe(0);
    }

    await cleanup(host, sandbox, { label: "final-cleanup", verify: true });
    await artifacts.writeJson("scenario-result.json", { id: "cloud-onboard", status: "passed" });
  },
);
