// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";

// Migrated from test/e2e/test-credential-migration.sh. This is a focused live
// Vitest test for the credential migration contract: a pre-gateway plaintext
// ~/.nemoclaw/credentials.json is staged only for allowlisted credential keys,
// a successful real onboard registers the migrated value with the OpenShell
// gateway, the plaintext file is removed after success, credentials list reads
// from the gateway, and secure unlink removes a planted symlink without touching
// its target. The repository secret is named NVIDIA_INFERENCE_API_KEY, but the
// hosted E2E service is the OpenAI-compatible inference-api.nvidia.com endpoint,
// so the migration contract stages that value as COMPATIBLE_API_KEY and expects
// the compatible-endpoint gateway provider.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const DIST_CREDENTIAL_STORE = path.join(REPO_ROOT, "dist", "lib", "credentials", "store.js");
const ONBOARD_TIMEOUT_MS = 30 * 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? `e2e-cred-migration-${process.pid}`;
const CREDENTIAL_MIGRATION_MODEL = "openai/gpt-oss-120b";
validateSandboxName(SANDBOX_NAME);

const runCredentialMigrationTest = shouldRunLiveE2EScenarios() ? test : test.skip;

type CommandResult = { stdout: string; stderr: string; exitCode: number | null };

function resultText(result: { stdout: string; stderr: string }): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function testEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const base = buildAvailabilityProbeEnv();
  return {
    ...base,
    HOME: home,
    PATH: [path.join(home, ".local", "bin"), base.PATH].filter(Boolean).join(":"),
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    ...extra,
  };
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup probes are intentionally best-effort. Some paths fail before
    // openshell is installed or before gateway/sandbox state exists.
  }
}

async function ensureOpenshellAvailable(host: HostCliClient, home: string): Promise<CommandResult> {
  const env = testEnv(home);
  const current = await host.command(
    "bash",
    ["-lc", "command -v openshell && openshell --version"],
    {
      artifactName: "prereq-openshell-version",
      env,
      timeoutMs: 30_000,
    },
  );
  if (current.exitCode === 0) return current;

  const install = await host.command(
    "bash",
    [path.join(REPO_ROOT, "scripts", "install-openshell.sh")],
    {
      artifactName: "prereq-install-openshell",
      cwd: REPO_ROOT,
      env,
      timeoutMs: INSTALL_TIMEOUT_MS,
    },
  );
  expect(install.exitCode, `install-openshell.sh failed\n${resultText(install)}`).toBe(0);

  const afterInstall = await host.command(
    "bash",
    ["-lc", "command -v openshell && openshell --version"],
    {
      artifactName: "prereq-openshell-version-after-install",
      env: testEnv(home),
      timeoutMs: 30_000,
    },
  );
  expect(
    afterInstall.exitCode,
    `openshell missing after install\n${resultText(afterInstall)}`,
  ).toBe(0);
  return afterInstall;
}

async function cleanupCredentialMigrationState(host: HostCliClient, home: string): Promise<void> {
  const env = testEnv(home);
  await bestEffort(() =>
    host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "cleanup-nemoclaw-destroy",
      env,
      redactionValues: [
        process.env.NVIDIA_INFERENCE_API_KEY ?? "",
        process.env.COMPATIBLE_API_KEY ?? "",
      ],
      timeoutMs: 120_000,
    }),
  );
  await bestEffort(() =>
    host.command("openshell", ["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-delete",
      env,
      timeoutMs: 60_000,
    }),
  );
  await bestEffort(() =>
    host.command("openshell", ["forward", "stop", "18789"], {
      artifactName: "cleanup-openshell-forward-stop",
      env,
      timeoutMs: 30_000,
    }),
  );
  await bestEffort(() =>
    host.command("openshell", ["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "cleanup-openshell-gateway-destroy",
      env,
      timeoutMs: 120_000,
    }),
  );
}

runCredentialMigrationTest(
  "credential migration stages legacy file into gateway and removes plaintext safely",
  { timeout: ONBOARD_TIMEOUT_MS + INSTALL_TIMEOUT_MS + 5 * 60_000 },
  async ({ artifacts, cleanup, host, secrets, skip }) => {
    // Use the existing nightly secret as the legacy provider credential. The
    // onboard child env below deliberately does not receive that credential, so
    // the only source is ~/.nemoclaw/credentials.json — matching the retired
    // shell lane's migration contract.
    const hostedInference = requireHostedInferenceConfig(secrets, process.env, {
      model: CREDENTIAL_MIGRATION_MODEL,
    });
    const migratedCredentialValue = hostedInference.apiKey;
    const {
      [hostedInference.credentialEnv]: _omittedCredential,
      ...hostedInferenceEnvWithoutCredential
    } = hostedInference.env;
    expect(fs.existsSync(CLI_ENTRYPOINT), "bin/nemoclaw.js missing").toBe(true);
    expect(
      fs.existsSync(DIST_CREDENTIAL_STORE),
      "run `npm run build:cli` before this live test",
    ).toBe(true);

    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required for credential migration live E2E: ${resultText(docker)}`,
        );
      }
      skip("Docker is required for credential migration live E2E");
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cred-migration-"));
    const nemoclawDir = path.join(home, ".nemoclaw");
    const legacyFile = path.join(nemoclawDir, "credentials.json");
    cleanup.add(`remove credential migration state for ${SANDBOX_NAME}`, async () => {
      await cleanupCredentialMigrationState(host, home);
      fs.rmSync(home, { recursive: true, force: true });
    });

    await artifacts.writeJson("scenario.json", {
      id: "credential-migration",
      runner: "vitest",
      boundary: "real-onboard-openshell-gateway",
      migratedFrom: "test/e2e/test-credential-migration.sh",
      sandboxName: SANDBOX_NAME,
      contracts: [
        "legacy credentials.json stages allowlisted provider keys into onboard env",
        `successful onboard registers the migrated value with the ${hostedInference.providerName} OpenShell gateway provider`,
        `${hostedInference.sourceSecretName} is migrated into the ${hostedInference.credentialEnv} provider credential`,
        `onboard uses the ${hostedInference.provider} provider and ${hostedInference.endpointUrl} endpoint path`,
        "successful onboard removes plaintext credentials.json",
        "tampered non-credential keys do not become gateway providers",
        "credentials list reads providers from the gateway, not disk",
        "secure unlink removes a final-component symlink without touching its target",
      ],
    });

    await ensureOpenshellAvailable(host, home);
    await cleanupCredentialMigrationState(host, home);

    fs.rmSync(nemoclawDir, { recursive: true, force: true });
    fs.mkdirSync(nemoclawDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      legacyFile,
      JSON.stringify(
        {
          [hostedInference.credentialEnv]: migratedCredentialValue,
          OPENSHELL_GATEWAY: "evil-gw-from-tampered-file",
          NODE_OPTIONS: "--require=/tmp/evil.js",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const onboard = await host.command("node", [CLI_ENTRYPOINT, "onboard", "--non-interactive"], {
      artifactName: "onboard-from-legacy-credentials",
      env: testEnv(home, {
        ...hostedInferenceEnvWithoutCredential,
        NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
        NEMOCLAW_RECREATE_SANDBOX: "1",
      }),
      redactionValues: [migratedCredentialValue],
      timeoutMs: ONBOARD_TIMEOUT_MS,
    });
    const onboardText = resultText(onboard);
    expect(onboard.exitCode, onboardText).toBe(0);
    expect(onboardText).toContain(
      "Staged 1 legacy credential(s) for migration to the OpenShell gateway.",
    );
    expect(fs.existsSync(legacyFile), "legacy credentials.json must be removed after onboard").toBe(
      false,
    );

    const providers = await host.command(
      "openshell",
      ["-g", "nemoclaw", "provider", "list", "--names"],
      {
        artifactName: "gateway-provider-list",
        env: testEnv(home),
        timeoutMs: 60_000,
      },
    );
    const providersText = resultText(providers);
    expect(providers.exitCode, providersText).toBe(0);
    const providerNames = providers.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(line));
    expect(
      providerNames,
      `expected migrated ${hostedInference.providerName} provider\n${providersText}`,
    ).toContain(hostedInference.providerName);
    expect(providerNames).not.toContain("OPENSHELL_GATEWAY");
    expect(providerNames).not.toContain("NODE_OPTIONS");

    const credentialsList = await host.command("node", [CLI_ENTRYPOINT, "credentials", "list"], {
      artifactName: "nemoclaw-credentials-list",
      env: testEnv(home),
      redactionValues: [migratedCredentialValue],
      timeoutMs: 60_000,
    });
    const credentialsText = resultText(credentialsList);
    expect(credentialsList.exitCode, credentialsText).toBe(0);
    expect(credentialsText).toContain("Providers registered with the OpenShell gateway");
    expect(
      fs.existsSync(legacyFile),
      "credentials list must not recreate plaintext credentials.json",
    ).toBe(false);

    const victimFile = path.join(home, "victim.txt");
    const victimPayload = "important data the attacker should not touch";
    fs.writeFileSync(victimFile, victimPayload, { mode: 0o600 });
    fs.symlinkSync(victimFile, legacyFile);

    const unlink = await host.command(
      "node",
      [
        "-e",
        `const { removeLegacyCredentialsFile } = require(${JSON.stringify(DIST_CREDENTIAL_STORE)}); removeLegacyCredentialsFile();`,
      ],
      {
        artifactName: "remove-legacy-credentials-symlink",
        env: testEnv(home),
        timeoutMs: 30_000,
      },
    );
    expect(unlink.exitCode, resultText(unlink)).toBe(0);
    expect(fs.existsSync(legacyFile), "symlink at credentials path must be removed").toBe(false);
    expect(fs.existsSync(victimFile), "symlink target must remain present").toBe(true);
    expect(fs.readFileSync(victimFile, "utf-8")).toBe(victimPayload);

    await artifacts.writeJson("scenario-result.json", {
      id: "credential-migration",
      sandboxName: SANDBOX_NAME,
      model: hostedInference.model || CREDENTIAL_MIGRATION_MODEL,
      provider: hostedInference.providerName,
      credentialEnv: hostedInference.credentialEnv,
      providerNames,
      assertions: {
        onboardSucceeded: onboard.exitCode === 0,
        migrationNoticeEmitted: onboardText.includes(
          "Staged 1 legacy credential(s) for migration to the OpenShell gateway.",
        ),
        legacyFileRemovedAfterOnboard: !fs.existsSync(legacyFile),
        migratedProviderRegistered: providerNames.includes(hostedInference.providerName),
        tamperedKeysExcluded:
          !providerNames.includes("OPENSHELL_GATEWAY") && !providerNames.includes("NODE_OPTIONS"),
        credentialsListReadsGateway: credentialsText.includes(
          "Providers registered with the OpenShell gateway",
        ),
        symlinkTargetUntouched:
          fs.existsSync(victimFile) && fs.readFileSync(victimFile, "utf-8") === victimPayload,
      },
    });
  },
);
