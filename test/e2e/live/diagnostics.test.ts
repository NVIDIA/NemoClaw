// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Preserves the real boundaries: repo CLI/version, debug archive
 * creation/extraction, credential redaction checks, install.sh/onboard,
 * Docker/OpenShell sandbox registration, sandbox exec for openclaw.json, host
 * status output, and gateway-backed credentials list/reset behavior.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { testHomeEnvironment } from "../fixtures/environment-profiles.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? `e2e-diag-${process.pid}`;
const DEBUG_QUICK_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 35 * 60_000;
const TEST_TIMEOUT_MS = 55 * 60_000;
validateSandboxName(SANDBOX_NAME);

type RawCommandResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

function rawResultText(result: Pick<RawCommandResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function redactForAssertion(text: string, apiKey: string): string {
  return text
    .split(apiKey)
    .join("[REDACTED]")
    .replace(/nvapi-[A-Za-z0-9_-]{10,}/g, "<REDACTED>");
}

function runRawNodeCliForLeakAssertion(args: string[], env: NodeJS.ProcessEnv): RawCommandResult {
  const result = spawnSync("node", [CLI_ENTRYPOINT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
    killSignal: "SIGKILL",
    timeout: 60_000,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function testEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return testHomeEnvironment(home, {
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT: "1",
    ...extra,
  });
}

async function preCleanBestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup probes are intentionally best-effort so they do not mask the
    // primary diagnostics assertion.
  }
}

function assertNoSecretInExtractedArchive(extractDir: string, apiKey: string): void {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  };
  visit(extractDir);

  const leakedFiles: string[] = [];
  const patternLeaks: string[] = [];
  const apiKeyBytes = Buffer.from(apiKey, "utf8");
  for (const file of files) {
    const content = fs.readFileSync(file);
    const text = content.toString("utf8");
    if (content.includes(apiKeyBytes)) leakedFiles.push(path.relative(extractDir, file));
    if (/nvapi-[A-Za-z0-9_-]{10,}/.test(text)) patternLeaks.push(path.relative(extractDir, file));
  }

  expect(leakedFiles, "debug archive must not contain the exact NVIDIA_INFERENCE_API_KEY").toEqual(
    [],
  );
  expect(patternLeaks, "debug archive must not contain nvapi-shaped credentials").toEqual([]);
}

test("diagnostics CLI creates sanitized archives and validates sandbox/credential diagnostics", {
  timeout: TEST_TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "validate diagnostics runtime prerequisites",
      "exercise quick debug archive",
      "install diagnostics sandbox",
      "inspect sanitized full and scoped archives",
      "validate sandbox status and config",
      "audit and reset gateway credentials",
    ],
  },
}, async ({ artifacts, cleanup, host, progress, sandbox, secrets, skip }) => {
  expect(
    fs.existsSync(CLI_ENTRYPOINT),
    "run `npm run build:cli` before live repo CLI targets",
  ).toBe(true);

  const hosted = requireHostedInferenceConfig(secrets);
  const apiKey = hosted.apiKey;
  await artifacts.target.declare({
    id: "diagnostics",
    boundary: "debug-archive-install-sh-docker-openshell-sandbox-exec-credentials",
    sandboxName: SANDBOX_NAME,
    contracts: [
      "nemoclaw --version exits zero and prints semver",
      "nemoclaw debug --quick creates a non-empty archive within the quick timeout",
      "nemoclaw debug --output creates an extractable archive without NVIDIA credential values",
      "debug --sandbox accepts a registered sandbox and rejects an unknown sandbox without a partial archive",
      "sandbox openclaw.json is readable through real OpenShell sandbox exec and host status includes model data",
      "credentials list hides secret values and credentials reset removes an explicitly detached provider credential from the gateway",
    ],
  });

  const docker = await host.command("docker", ["info"], {
    artifactName: "prereq-docker-info-diagnostics",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  if (docker.exitCode !== 0) {
    if (process.env.GITHUB_ACTIONS === "true") {
      throw new Error(`Docker is required for diagnostics live E2E: ${resultText(docker)}`);
    }
    skip("Docker is required for diagnostics live E2E");
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-diagnostics-home-"));
  const cleanupEnv = testEnv(home);
  cleanup.trackDisposable("remove diagnostics home", () => {
    fs.rmSync(home, { recursive: true, force: true });
  });
  cleanup.trackGateway(host, "nemoclaw", {
    artifactName: "cleanup-openshell-gateway-destroy-diagnostics",
    env: cleanupEnv,
    redactionValues: [apiKey],
    timeoutMs: 120_000,
  });
  cleanup.trackDisposable(`delete OpenShell sandbox ${SANDBOX_NAME}`, () =>
    sandbox.cleanupSandbox(SANDBOX_NAME, {
      artifactName: "cleanup-openshell-sandbox-delete-diagnostics",
      env: cleanupEnv,
      redactionValues: [apiKey],
      timeoutMs: 60_000,
    }),
  );
  cleanup.trackSandbox(host, SANDBOX_NAME, {
    artifactName: "cleanup-nemoclaw-destroy-diagnostics",
    env: cleanupEnv,
    redactionValues: [apiKey],
    timeoutMs: 120_000,
  });

  const env = testEnv(home, hosted.env);
  await preCleanBestEffort(() =>
    host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "pre-cleanup-nemoclaw-destroy-diagnostics",
      env,
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    }),
  );
  await preCleanBestEffort(() =>
    sandbox.cleanupSandbox(SANDBOX_NAME, {
      artifactName: "pre-cleanup-openshell-sandbox-delete-diagnostics",
      env,
      timeoutMs: 60_000,
    }),
  );

  progress.phase("exercise quick debug archive");
  const version = await host.command("node", [CLI_ENTRYPOINT, "--version"], {
    artifactName: "diagnostics-nemoclaw-version",
    env: testEnv(home),
    timeoutMs: 30_000,
  });
  expect(version.exitCode, resultText(version)).toBe(0);
  expect(resultText(version)).toMatch(/\d+\.\d+\.\d+/);

  const quickDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-debug-quick-"));
  const quickArchive = path.join(quickDir, "quick-debug.tar.gz");
  const quickStartedAt = Date.now();
  const quick = await host.command(
    "node",
    [CLI_ENTRYPOINT, "debug", "--quick", "--output", quickArchive],
    {
      artifactName: "diagnostics-debug-quick",
      env: testEnv(home, { NEMOCLAW_SANDBOX_NAME: "" }),
      timeoutMs: DEBUG_QUICK_TIMEOUT_MS,
    },
  );
  const quickElapsedMs = Date.now() - quickStartedAt;
  expect(quick.exitCode, resultText(quick)).toBe(0);
  expect(fs.existsSync(quickArchive), "debug --quick must create an archive").toBe(true);
  expect(fs.statSync(quickArchive).size, "debug --quick archive must be non-empty").toBeGreaterThan(
    0,
  );
  expect(
    quickElapsedMs,
    "debug --quick must complete within the legacy 30s process timeout plus harness scheduling grace",
  ).toBeLessThanOrEqual(DEBUG_QUICK_TIMEOUT_MS + 5_000);

  progress.phase("install diagnostics sandbox");
  const install = await host.command(
    "bash",
    ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software"],
    {
      artifactName: "install-and-onboard-diagnostics",
      cwd: REPO_ROOT,
      env,
      redactionValues: [apiKey],
      timeoutMs: INSTALL_TIMEOUT_MS,
    },
  );
  expect(install.exitCode, resultText(install)).toBe(0);

  progress.phase("inspect sanitized full and scoped archives");
  const fullDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-debug-full-"));
  const fullArchive = path.join(fullDir, "debug-full.tar.gz");
  const extractDir = path.join(fullDir, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });
  const fullDebug = await host.command("node", [CLI_ENTRYPOINT, "debug", "--output", fullArchive], {
    artifactName: "diagnostics-debug-full",
    env,
    redactionValues: [apiKey],
    timeoutMs: 180_000,
  });
  expect(fullDebug.exitCode, resultText(fullDebug)).toBe(0);
  expect(fs.existsSync(fullArchive), "debug --output must create an archive").toBe(true);
  expect(fs.statSync(fullArchive).size, "debug --output archive must be non-empty").toBeGreaterThan(
    0,
  );
  const extract = await host.command("tar", ["xzf", fullArchive, "-C", extractDir], {
    artifactName: "diagnostics-debug-full-extract",
    env: testEnv(home),
    timeoutMs: 60_000,
  });
  expect(extract.exitCode, resultText(extract)).toBe(0);
  assertNoSecretInExtractedArchive(extractDir, apiKey);

  const knownArchive = path.join(fullDir, "known-sandbox.tar.gz");
  const knownSandboxDebug = await host.command(
    "node",
    [CLI_ENTRYPOINT, "debug", "--quick", "--sandbox", SANDBOX_NAME, "--output", knownArchive],
    {
      artifactName: "diagnostics-debug-known-sandbox",
      env,
      redactionValues: [apiKey],
      timeoutMs: DEBUG_QUICK_TIMEOUT_MS,
    },
  );
  expect(knownSandboxDebug.exitCode, resultText(knownSandboxDebug)).toBe(0);
  expect(fs.existsSync(knownArchive), "registered --sandbox must create an archive").toBe(true);
  expect(
    fs.statSync(knownArchive).size,
    "registered --sandbox archive must be non-empty",
  ).toBeGreaterThan(0);

  const missingName = `nemoclaw-e2e-missing-${process.pid}-${Date.now()}`;
  const missingArchive = path.join(fullDir, "unknown-sandbox.tar.gz");
  const unknownSandboxDebug = await host.command(
    "node",
    [CLI_ENTRYPOINT, "debug", "--quick", "--sandbox", missingName, "--output", missingArchive],
    {
      artifactName: "diagnostics-debug-unknown-sandbox",
      env,
      redactionValues: [apiKey],
      timeoutMs: DEBUG_QUICK_TIMEOUT_MS,
    },
  );
  const unknownText = resultText(unknownSandboxDebug);
  expect(unknownSandboxDebug.exitCode, unknownText).not.toBe(0);
  expect(unknownText).toContain(missingName);
  expect(unknownText).toMatch(/not registered/i);
  expect(fs.existsSync(missingArchive), "unknown --sandbox must not leave a partial archive").toBe(
    false,
  );

  progress.phase("validate sandbox status and config");
  const config = await sandbox.exec(
    SANDBOX_NAME,
    ["sh", "-lc", "cat /sandbox/.openclaw/openclaw.json"],
    {
      artifactName: "diagnostics-sandbox-openclaw-config",
      env,
      redactionValues: [apiKey],
      timeoutMs: 60_000,
    },
  );
  expect(config.exitCode, resultText(config)).toBe(0);
  expect(config.stdout.trim(), "openclaw.json must be readable inside sandbox").not.toBe("");

  const status = await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "status"], {
    artifactName: "diagnostics-nemoclaw-status",
    env,
    redactionValues: [apiKey],
    timeoutMs: 60_000,
  });
  expect(status.exitCode, resultText(status)).toBe(0);
  expect(resultText(status)).toMatch(/Model/i);

  progress.phase("audit and reset gateway credentials");
  const rawCredentialsList = runRawNodeCliForLeakAssertion(["credentials", "list"], env);
  const credentialsOutput = rawResultText(rawCredentialsList);
  const credentialsStdout = rawCredentialsList.stdout;
  expect(rawCredentialsList.status, redactForAssertion(credentialsOutput, apiKey)).toBe(0);
  expect(
    credentialsOutput.includes(apiKey),
    "credentials list must not expose the exact NVIDIA_INFERENCE_API_KEY",
  ).toBe(false);
  expect(
    /nvapi-[A-Za-z0-9_-]{10,}/.test(credentialsOutput),
    "credentials list must not expose nvapi-shaped values",
  ).toBe(false);
  expect(
    credentialsStdout.includes(hosted.providerName) ||
      /No provider credentials registered/i.test(credentialsStdout),
  ).toBe(true);

  await host.command("node", [CLI_ENTRYPOINT, "credentials", "list"], {
    artifactName: "diagnostics-credentials-list",
    env,
    redactionValues: [apiKey],
    timeoutMs: 60_000,
  });

  let credentialsResetExercised = false;
  let postResetCredentialsListRedacted = false;
  let providerCredentialAbsentBeforeReset = false;
  let providerDetachedBeforeReset = false;
  if (credentialsStdout.includes(hosted.providerName)) {
    credentialsResetExercised = true;
    const detach = await sandbox.openshell(
      ["sandbox", "provider", "detach", SANDBOX_NAME, hosted.providerName],
      {
        artifactName: "diagnostics-inference-provider-detach-before-credentials-reset",
        env,
        redactionValues: [apiKey],
        timeoutMs: 60_000,
      },
    );
    expect(detach.exitCode, resultText(detach)).toBe(0);

    const providersAfterDetach = await sandbox.openshell(
      ["sandbox", "provider", "list", SANDBOX_NAME],
      {
        artifactName: "diagnostics-inference-providers-after-detach",
        env,
        redactionValues: [apiKey],
        timeoutMs: 60_000,
      },
    );
    expect(providersAfterDetach.exitCode, resultText(providersAfterDetach)).toBe(0);
    expect(providersAfterDetach.stdout, resultText(providersAfterDetach)).not.toContain(
      hosted.providerName,
    );
    providerDetachedBeforeReset = true;

    const reset = await host.command(
      "node",
      [CLI_ENTRYPOINT, "credentials", "reset", hosted.providerName, "--yes"],
      {
        artifactName: "diagnostics-credentials-reset",
        env,
        redactionValues: [apiKey],
        timeoutMs: 60_000,
      },
    );
    expect(reset.exitCode, resultText(reset)).toBe(0);
    expect(reset.stdout, resultText(reset)).toContain(`Removed provider '${hosted.providerName}'`);

    const rawPostResetList = runRawNodeCliForLeakAssertion(["credentials", "list"], env);
    const postResetOutput = rawResultText(rawPostResetList);
    expect(rawPostResetList.status, redactForAssertion(postResetOutput, apiKey)).toBe(0);
    expect(
      rawPostResetList.stdout.includes(hosted.providerName),
      redactForAssertion(postResetOutput, apiKey),
    ).toBe(false);
    expect(
      postResetOutput.includes(apiKey),
      "post-reset credentials list must not expose the exact NVIDIA_INFERENCE_API_KEY",
    ).toBe(false);
    expect(
      /nvapi-[A-Za-z0-9_-]{10,}/.test(postResetOutput),
      "post-reset credentials list must not expose nvapi-shaped values",
    ).toBe(false);
    postResetCredentialsListRedacted = !postResetOutput.includes(apiKey);

    await host.command("node", [CLI_ENTRYPOINT, "credentials", "list"], {
      artifactName: "diagnostics-credentials-list-after-reset",
      env,
      redactionValues: [apiKey],
      timeoutMs: 60_000,
    });
  } else {
    providerCredentialAbsentBeforeReset = true;
    await artifacts.writeJson("credentials-reset.skip.json", {
      provider: hosted.providerName,
      reason: `credentials list reported no ${hosted.providerName} provider credential after install/onboard`,
      acceptedNoProviderStore: /No provider credentials registered/i.test(credentialsStdout),
    });
  }

  await artifacts.target.complete({
    id: "diagnostics",
    sandboxName: SANDBOX_NAME,
    model: hosted.model,
    assertions: {
      versionPrintedSemver: /\d+\.\d+\.\d+/.test(resultText(version)),
      quickDebugArchiveCreated: fs.existsSync(quickArchive) && fs.statSync(quickArchive).size > 0,
      fullDebugArchiveCreated: fs.existsSync(fullArchive) && fs.statSync(fullArchive).size > 0,
      fullDebugArchiveSanitized: true,
      registeredSandboxDebugAccepted: knownSandboxDebug.exitCode === 0,
      unknownSandboxDebugRejected: unknownSandboxDebug.exitCode !== 0,
      sandboxConfigReadable: config.exitCode === 0 && config.stdout.trim().length > 0,
      statusShowsModel: /Model/i.test(resultText(status)),
      credentialsListRedacted: !credentialsOutput.includes(apiKey),
      credentialsResetExercised,
      providerCredentialAbsentBeforeReset,
      providerDetachedBeforeReset,
      postResetCredentialsListRedacted,
    },
  });
});
