// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest replacement for test/e2e/test-diagnostics.sh.
 *
 * Preserves the legacy real boundaries: repo CLI/version, debug archive
 * creation/extraction, credential redaction checks, install.sh/onboard,
 * Docker/OpenShell sandbox registration, sandbox exec for openclaw.json, host
 * status output, and gateway-backed credentials list/reset behavior.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? `e2e-diag-${process.pid}`;
const DIAGNOSTICS_MODEL = process.env.NEMOCLAW_MODEL ?? "openai/gpt-oss-120b";
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

function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function rawResultText(result: Pick<RawCommandResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function redactForAssertion(text: string, apiKey: string): string {
  return text
    .split(apiKey)
    .join("[REDACTED]")
    .replace(/nvapi-[A-Za-z0-9_-]{10,}/g, "<REDACTED>");
}

function runRawNodeCliForLeakAssertion(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): RawCommandResult {
  const result = spawnSync("node", [CLI_ENTRYPOINT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
    killSignal: "SIGKILL",
    timeout: timeoutMs,
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
  const base = buildAvailabilityProbeEnv();
  return {
    ...base,
    HOME: home,
    PATH: [path.join(home, ".local", "bin"), base.PATH].filter(Boolean).join(":"),
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NEMOCLAW_MODEL: DIAGNOSTICS_MODEL,
    NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT: "1",
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
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

  expect(leakedFiles, "debug archive must not contain the exact NVIDIA_API_KEY").toEqual([]);
  expect(patternLeaks, "debug archive must not contain nvapi-shaped credentials").toEqual([]);
}

const runDiagnosticsTest = shouldRunLiveE2EScenarios() ? test : test.skip;

runDiagnosticsTest(
  "diagnostics CLI creates sanitized archives and validates sandbox/credential diagnostics",
  { timeout: TEST_TIMEOUT_MS },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      "run `npm run build:cli` before live repo CLI scenarios",
    ).toBe(true);

    const apiKey = secrets.required("NVIDIA_API_KEY");
    expect(apiKey.startsWith("nvapi-"), "NVIDIA_API_KEY must start with nvapi-").toBe(true);

    await artifacts.writeJson("scenario.json", {
      id: "diagnostics",
      runner: "vitest",
      boundary: "debug-archive-install-sh-docker-openshell-sandbox-exec-credentials",
      legacySource: "test/e2e/test-diagnostics.sh",
      sandboxName: SANDBOX_NAME,
      contracts: [
        "nemoclaw --version exits zero and prints semver",
        "nemoclaw debug --quick creates a non-empty archive within the quick timeout",
        "nemoclaw debug --output creates an extractable archive without NVIDIA credential values",
        "debug --sandbox accepts a registered sandbox and rejects an unknown sandbox without a partial archive",
        "sandbox openclaw.json is readable through real OpenShell sandbox exec and host status includes model data",
        "credentials list hides secret values and credentials reset removes the provider credential from the gateway",
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
    cleanup.add(`remove diagnostics state for ${SANDBOX_NAME}`, async () => {
      const env = testEnv(home);
      await bestEffort(() =>
        host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
          artifactName: "cleanup-nemoclaw-destroy-diagnostics",
          env,
          redactionValues: [apiKey],
          timeoutMs: 120_000,
        }),
      );
      await bestEffort(() =>
        host.command("openshell", ["sandbox", "delete", SANDBOX_NAME], {
          artifactName: "cleanup-openshell-sandbox-delete-diagnostics",
          env,
          timeoutMs: 60_000,
        }),
      );
      await bestEffort(() =>
        host.command("openshell", ["gateway", "destroy", "-g", "nemoclaw"], {
          artifactName: "cleanup-openshell-gateway-destroy-diagnostics",
          env,
          timeoutMs: 120_000,
        }),
      );
      fs.rmSync(home, { recursive: true, force: true });
    });

    const env = testEnv(home, { NVIDIA_API_KEY: apiKey });
    await bestEffort(() =>
      host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "pre-cleanup-nemoclaw-destroy-diagnostics",
        env,
        redactionValues: [apiKey],
        timeoutMs: 120_000,
      }),
    );
    await bestEffort(() =>
      host.command("openshell", ["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "pre-cleanup-openshell-sandbox-delete-diagnostics",
        env,
        timeoutMs: 60_000,
      }),
    );

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
    expect(
      fs.statSync(quickArchive).size,
      "debug --quick archive must be non-empty",
    ).toBeGreaterThan(0);
    expect(
      quickElapsedMs,
      "debug --quick must complete within the legacy 30s process timeout plus harness scheduling grace",
    ).toBeLessThanOrEqual(DEBUG_QUICK_TIMEOUT_MS + 5_000);

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

    const fullDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-debug-full-"));
    const fullArchive = path.join(fullDir, "debug-full.tar.gz");
    const extractDir = path.join(fullDir, "extracted");
    fs.mkdirSync(extractDir, { recursive: true });
    const fullDebug = await host.command(
      "node",
      [CLI_ENTRYPOINT, "debug", "--output", fullArchive],
      {
        artifactName: "diagnostics-debug-full",
        env,
        redactionValues: [apiKey],
        timeoutMs: 180_000,
      },
    );
    expect(fullDebug.exitCode, resultText(fullDebug)).toBe(0);
    expect(fs.existsSync(fullArchive), "debug --output must create an archive").toBe(true);
    expect(
      fs.statSync(fullArchive).size,
      "debug --output archive must be non-empty",
    ).toBeGreaterThan(0);
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
    expect(
      fs.existsSync(missingArchive),
      "unknown --sandbox must not leave a partial archive",
    ).toBe(false);

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

    const rawCredentialsList = runRawNodeCliForLeakAssertion(["credentials", "list"], env, 60_000);
    const credentialsText = rawResultText(rawCredentialsList);
    expect(rawCredentialsList.status, redactForAssertion(credentialsText, apiKey)).toBe(0);
    expect(
      credentialsText.includes(apiKey),
      "credentials list must not expose the exact NVIDIA_API_KEY",
    ).toBe(false);
    expect(
      /nvapi-[A-Za-z0-9_-]{10,}/.test(credentialsText),
      "credentials list must not expose nvapi-shaped values",
    ).toBe(false);
    expect(/nvidia-prod|No provider credentials registered/i.test(credentialsText)).toBe(true);

    await host.command("node", [CLI_ENTRYPOINT, "credentials", "list"], {
      artifactName: "diagnostics-credentials-list",
      env,
      redactionValues: [apiKey],
      timeoutMs: 60_000,
    });

    let credentialsResetExercised = false;
    let postResetCredentialsListRedacted = false;
    let providerCredentialAbsentBeforeReset = false;
    if (credentialsText.includes("nvidia-prod")) {
      credentialsResetExercised = true;
      const reset = await host.command(
        "node",
        [CLI_ENTRYPOINT, "credentials", "reset", "nvidia-prod", "--yes"],
        {
          artifactName: "diagnostics-credentials-reset",
          env,
          redactionValues: [apiKey],
          timeoutMs: 60_000,
        },
      );
      expect(reset.exitCode, resultText(reset)).toBe(0);
      expect(resultText(reset)).toContain("Removed provider 'nvidia-prod'");

      const rawPostResetList = runRawNodeCliForLeakAssertion(["credentials", "list"], env, 60_000);
      const postResetText = rawResultText(rawPostResetList);
      expect(rawPostResetList.status, redactForAssertion(postResetText, apiKey)).toBe(0);
      expect(postResetText.includes("nvidia-prod")).toBe(false);
      expect(
        postResetText.includes(apiKey),
        "post-reset credentials list must not expose the exact NVIDIA_API_KEY",
      ).toBe(false);
      expect(
        /nvapi-[A-Za-z0-9_-]{10,}/.test(postResetText),
        "post-reset credentials list must not expose nvapi-shaped values",
      ).toBe(false);
      postResetCredentialsListRedacted = !postResetText.includes(apiKey);

      await host.command("node", [CLI_ENTRYPOINT, "credentials", "list"], {
        artifactName: "diagnostics-credentials-list-after-reset",
        env,
        redactionValues: [apiKey],
        timeoutMs: 60_000,
      });
    } else {
      providerCredentialAbsentBeforeReset = true;
      await artifacts.writeJson("credentials-reset.skip.json", {
        provider: "nvidia-prod",
        reason:
          "credentials list reported no nvidia-prod provider credential after install/onboard",
        acceptedNoProviderStore: /No provider credentials registered/i.test(credentialsText),
      });
    }

    await artifacts.writeJson("scenario-result.json", {
      id: "diagnostics",
      sandboxName: SANDBOX_NAME,
      model: DIAGNOSTICS_MODEL,
      assertions: {
        versionPrintedSemver: /\d+\.\d+\.\d+/.test(resultText(version)),
        quickDebugArchiveCreated: fs.existsSync(quickArchive) && fs.statSync(quickArchive).size > 0,
        fullDebugArchiveCreated: fs.existsSync(fullArchive) && fs.statSync(fullArchive).size > 0,
        fullDebugArchiveSanitized: true,
        registeredSandboxDebugAccepted: knownSandboxDebug.exitCode === 0,
        unknownSandboxDebugRejected: unknownSandboxDebug.exitCode !== 0,
        sandboxConfigReadable: config.exitCode === 0 && config.stdout.trim().length > 0,
        statusShowsModel: /Model/i.test(resultText(status)),
        credentialsListRedacted: !credentialsText.includes(apiKey),
        credentialsResetExercised,
        providerCredentialAbsentBeforeReset,
        postResetCredentialsListRedacted,
      },
    });
  },
);
