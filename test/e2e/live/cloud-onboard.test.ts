// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execTimeout } from "../../helpers/timeouts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText, shellQuote } from "../fixtures/clients/command.ts";
import { type HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import {
  cleanupCorporateCaFixture,
  corporateCaMergeProbeScript,
  createCorporateCaFixture,
  registeredCorporateCaWorkloadKind,
} from "../fixtures/corporate-ca.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { assertStockManagedImageReceipt } from "../fixtures/managed-image-receipt.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-cloud-onboard";
const CHECKS_DIR = path.join(REPO_ROOT, "test/e2e/e2e-cloud-experimental/checks");
const LIVE_TIMEOUT_MS = 60 * 60_000;
const REASONING_PROPAGATION_PROBE = String.raw`
const fs = require("node:fs");
const expectedModel = process.argv[1];
const runtimeEnvironmentPath = "/run/nemoclaw/managed-startup-runtime.env";
const runtimeEnvironmentStat = fs.lstatSync(runtimeEnvironmentPath);
if (
  !runtimeEnvironmentStat.isFile() ||
  runtimeEnvironmentStat.isSymbolicLink() ||
  runtimeEnvironmentStat.uid !== 0 ||
  runtimeEnvironmentStat.gid !== 0 ||
  (runtimeEnvironmentStat.mode & 0o777) !== 0o444
) {
  throw new Error("managed startup runtime environment is not a root-owned mode 0444 regular file");
}
const runtimeReasoningLines = fs
  .readFileSync(runtimeEnvironmentPath, "utf8")
  .split(/\r?\n/u)
  .filter((line) => line.startsWith("export NEMOCLAW_REASONING="));
if (runtimeReasoningLines.length !== 1) {
  throw new Error("managed startup runtime environment must export NEMOCLAW_REASONING exactly once");
}
const runtimeReasoningMatch = /^export NEMOCLAW_REASONING='(true|false)'$/u.exec(
  runtimeReasoningLines[0],
);
if (runtimeReasoningMatch === null) {
  throw new Error("managed startup runtime environment has an invalid NEMOCLAW_REASONING export");
}
const config = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
const models = config.models?.providers?.inference?.models ?? [];
const model = models.find((entry) => entry?.id === expectedModel);
const evidence = {
  runtimeReasoning: runtimeReasoningMatch[1],
  modelReasoning: model?.reasoning,
};
console.log(JSON.stringify(evidence));
process.exit(evidence.runtimeReasoning === "true" && evidence.modelReasoning === true ? 0 : 1);
`;

validateSandboxName(SANDBOX_NAME);

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const home = extra.HOME || os.homedir();
  return {
    ...buildAvailabilityProbeEnv(),
    PATH: `${home}/.local/bin:${home}/.npm-global/bin:${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${process.env.PATH ?? ""}`,
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

async function cleanup(
  host: HostCliClient,
  sandbox: SandboxClient,
  options: { verify: boolean; label: string; home: string },
): Promise<void> {
  const args = [path.join(REPO_ROOT, "test/e2e/e2e-cloud-experimental/cleanup.sh")];
  if (options.verify) args.push("--verify");
  const cleanupResult = await host.command("bash", args, {
    artifactName: `${options.label}-cloud-experimental-cleanup`,
    env: env({ HOME: options.home }),
    timeoutMs: 180_000,
  });
  if (options.verify) {
    expect(cleanupResult.exitCode, resultText(cleanupResult)).toBe(0);
  }

  const gatewayDestroy = await sandbox.openshell(["gateway", "destroy", "-g", "nemoclaw"], {
    artifactName: `${options.label}-openshell-gateway-destroy`,
    env: env({ HOME: options.home }),
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

test(
  "cloud onboard: public installer creates healthy sandbox with security checks",
  {
  timeout: LIVE_TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "check cloud onboarding prerequisites",
      "stage legacy plaintext credential",
      "install and onboard cloud sandbox",
      "verify migrated gateway credential",
      "validate installed CLI and corporate CA trust",
      "verify compatible endpoint reasoning propagation",
      "collect scoped diagnostics from onboarded sandbox",
      "run cloud inference and security checks",
      "remove cloud sandbox",
    ],
  },
  },
  async ({
    artifacts,
    cleanup: cleanupRegistry,
    host,
    progress,
    runtimeProvider,
    sandbox,
    secrets,
  }) => {
  const hosted = requireHostedInferenceConfig(secrets);
  const ref = publicInstallRef();
  const installUrl =
    process.env.NEMOCLAW_INSTALL_SCRIPT_URL ??
    `https://raw.githubusercontent.com/NVIDIA/NemoClaw/${ref}/install.sh`;
  const installCwd = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-public-install-"));
  const testHome = path.join(installCwd, "home");
  const legacyDir = path.join(testHome, ".nemoclaw");
  const legacyFile = path.join(legacyDir, "credentials.json");
  const testEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
    env({ HOME: testHome, ...extra });
  const hostedEnvWithoutCredentials = { ...hosted.env };
  delete hostedEnvWithoutCredentials[hosted.sourceSecretName];
  delete hostedEnvWithoutCredentials[hosted.credentialEnv];
  fs.mkdirSync(testHome, { recursive: true, mode: 0o700 });
  const corporateCa = createCorporateCaFixture("explicit", "nemoclaw-cloud-corporate-ca-");
  cleanupRegistry.trackDisposable("remove public installer workspace", () =>
    fs.rmSync(installCwd, { recursive: true, force: true }),
  );
  cleanupRegistry.trackDisposable("remove corporate CA fixture", () =>
    cleanupCorporateCaFixture(corporateCa),
  );
  const redactionValues = [hosted.apiKey];

  await artifacts.target.declare({
    id: "cloud-onboard",
    sandboxName: SANDBOX_NAME,
    installUrl,
    installRef: ref,
    checksDir: CHECKS_DIR,
    corporateCaSource: corporateCa.sourceLabel,
    contracts: [
      "public curl installer uses GitHub clone path for the requested ref",
      "ordinary cloud onboard migrates an allowlisted legacy credential through the real gateway",
      "tampered non-credential legacy fields do not become gateway providers",
      "successful onboard removes plaintext credentials.json",
      "sandbox appears healthy after cloud onboarding",
      "explicit corporate CA source is baked and merged with OpenShell trust inside the sandbox",
      "validated compatible-endpoint reasoning reaches the authenticated runtime handoff and OpenClaw model metadata",
      "installed CLI creates a non-empty diagnostics archive for the registered sandbox",
      "cloud split checks cover inference.local, security leak checks, and Landlock/read-only behavior",
      "cleanup verifies sandbox removal",
    ],
  });

    await runtimeProvider.requireAvailable({
    artifactName: "phase-0-docker-info",
      scenarioLabel: "cloud onboarding",
  });

  cleanupRegistry.trackDisposable("remove cloud-onboard sandbox", () =>
    cleanup(host, sandbox, { home: testHome, label: "cleanup", verify: true }),
  );
  await cleanup(host, sandbox, { home: testHome, label: "pre-cleanup", verify: false });

  progress.phase("stage legacy plaintext credential");
  fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    legacyFile,
    JSON.stringify(
      {
        [hosted.credentialEnv]: hosted.apiKey,
        OPENSHELL_GATEWAY: "evil-gw-from-tampered-file",
        NODE_OPTIONS: "--require=/tmp/evil.js",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  progress.phase("install and onboard cloud sandbox");
  const install = await host.command(
    "bash",
    ["-lc", `cd ${shellQuote(installCwd)} && curl -fsSL ${shellQuote(installUrl)} | bash`],
    {
      artifactName: "phase-1-public-install",
      env: testEnv({
        ...hostedEnvWithoutCredentials,
        ...corporateCa.env,
        NEMOCLAW_INSTALL_REF: ref,
        NEMOCLAW_INSTALL_TAG: ref,
        NEMOCLAW_INSTALL_SCRIPT_URL: installUrl,
        NEMOCLAW_REASONING: "true",
      }),
      redactionValues,
      timeoutMs: execTimeout(25 * 60_000),
    },
  );
  expect(install.exitCode, resultText(install)).toBe(0);
  assertStockManagedImageReceipt({
    environment: testEnv(),
    expectedAgent: "openclaw",
    sandboxName: SANDBOX_NAME,
  });
  expect(resultText(install)).toContain("Installing NemoClaw from GitHub");
  expect(resultText(install)).toContain("Cloning NemoClaw source");
  expect(resultText(install)).toContain(
    "Staged 1 legacy credential(s) for migration to the OpenShell gateway.",
  );
  if (ref !== "main") expect(resultText(install)).toContain(`Resolved install ref: ${ref}`);

  progress.phase("verify migrated gateway credential");
    expect(
      fs.existsSync(legacyFile),
      "successful onboard must remove legacy credentials.json",
    ).toBe(false);
  const providers = await host.command(
    "openshell",
    ["-g", "nemoclaw", "provider", "list", "--names"],
    {
      artifactName: "phase-2-gateway-provider-list",
      env: testEnv(),
      timeoutMs: 60_000,
    },
  );
  expect(providers.exitCode, resultText(providers)).toBe(0);
  const providerNames = providers.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(line));
  expect(providerNames).toContain(hosted.providerName);
  expect(providerNames).not.toContain("OPENSHELL_GATEWAY");
  expect(providerNames).not.toContain("NODE_OPTIONS");

  progress.phase("validate installed CLI and corporate CA trust");
  const cliProbe = await host.command(
    "bash",
    [
      "-lc",
      'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; command -v nemoclaw; command -v openshell; nemoclaw --help >/dev/null',
    ],
    { artifactName: "phase-2-cli-path-probe", env: testEnv(), timeoutMs: 60_000 },
  );
  expect(cliProbe.exitCode, resultText(cliProbe)).toBe(0);

  const list = await host.command("bash", ["-lc", "nemoclaw list"], {
    artifactName: "phase-2-nemoclaw-list",
    env: testEnv(),
    timeoutMs: 60_000,
  });
  expect(list.exitCode, resultText(list)).toBe(0);
  expect(list.stdout).toContain(SANDBOX_NAME);

  const corporateCaProbe = await sandbox.execShell(
    SANDBOX_NAME,
    corporateCaMergeProbeScript(registeredCorporateCaWorkloadKind(SANDBOX_NAME, testHome)),
    {
      artifactName: "phase-2-corporate-ca-merge-probe",
      env: testEnv(),
      timeoutMs: 60_000,
    },
  );
  expect(corporateCaProbe.exitCode, resultText(corporateCaProbe)).toBe(0);

  progress.phase("verify compatible endpoint reasoning propagation");
  const reasoningProbe = await sandbox.exec(
    SANDBOX_NAME,
    ["node", "-e", REASONING_PROPAGATION_PROBE, hosted.model],
    {
      artifactName: "phase-2-compatible-endpoint-reasoning",
      env: testEnv(),
      timeoutMs: 60_000,
    },
  );
  expect(reasoningProbe.exitCode, resultText(reasoningProbe)).toBe(0);
  const reasoningEvidence = JSON.parse(reasoningProbe.stdout.trim()) as {
    runtimeReasoning: string;
    modelReasoning: boolean;
  };
  expect(reasoningEvidence).toEqual({ runtimeReasoning: "true", modelReasoning: true });
  await artifacts.writeJson("compatible-endpoint-reasoning.json", reasoningEvidence);

  progress.phase("collect scoped diagnostics from onboarded sandbox");
  const diagnosticsArchive = path.join(installCwd, "cloud-onboard-debug.tar.gz");
  const diagnostics = await host.command(
    "bash",
    [
      "-lc",
      `nemoclaw debug --quick --sandbox ${shellQuote(SANDBOX_NAME)} --output ${shellQuote(diagnosticsArchive)}`,
    ],
    {
      artifactName: "phase-3-scoped-diagnostics",
      env: testEnv(),
      timeoutMs: 60_000,
    },
  );
  expect(diagnostics.exitCode, resultText(diagnostics)).toBe(0);
  expect(fs.existsSync(diagnosticsArchive), "scoped diagnostics archive must exist").toBe(true);
  expect(
    fs.statSync(diagnosticsArchive).size,
    "scoped diagnostics archive must be non-empty",
  ).toBeGreaterThan(0);

  progress.phase("run cloud inference and security checks");
  const checkScripts = fs
    .readdirSync(CHECKS_DIR)
    .filter((name) => name.endsWith(".sh"))
    .sort();
  expect(checkScripts.length).toBeGreaterThan(0);
  for (const scriptName of checkScripts) {
    const result = await host.command("bash", [path.join(CHECKS_DIR, scriptName)], {
      artifactName: `phase-4-check-${scriptName.replace(/\.sh$/, "")}`,
      cwd: REPO_ROOT,
      env: testEnv({
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

  progress.phase("remove cloud sandbox");
  await cleanup(host, sandbox, { home: testHome, label: "final-cleanup", verify: true });
  await artifacts.target.complete({
    id: "cloud-onboard",
    status: "passed",
    credentialMigration: {
      legacyFileRemoved: !fs.existsSync(legacyFile),
      migratedProviderRegistered: providerNames.includes(hosted.providerName),
      tamperedKeysExcluded:
        !providerNames.includes("OPENSHELL_GATEWAY") && !providerNames.includes("NODE_OPTIONS"),
    },
  });
  },
);
