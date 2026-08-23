// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  removeLegacyCredentialsFile,
  stageLegacyCredentialsToEnv,
} from "../src/lib/credentials/store.js";
import {
  type CredentialProviderRegistrationDeps,
  createCredentialProviderRegistration,
} from "../src/lib/onboard/credential-provider-registration.js";
import { handleFinalizationState } from "../src/lib/onboard/machine/handlers/finalization.js";
import type { MessagingTokenDef } from "../src/lib/onboard/messaging-prep.js";
import type { Session } from "../src/lib/state/onboard-session.js";
import { withProcessEnv } from "./support/setup-inference-test-harness.js";

const LEGACY_SECRET = "sk-TEST-NOT-A-REAL-STORED-KEY";

type RegistrationAttempt = ReturnType<
  ReturnType<typeof createCredentialProviderRegistration>["stageSandboxCredentialProviders"]
>;

const REGISTRATION_SCENARIOS = [
  {
    label: "keeps plaintext after gateway registration fails",
    registrationStatus: 1,
    settle: async (attempt: RegistrationAttempt) => {
      await expect(attempt).rejects.toThrow("gateway registration exited 1");
    },
    expectedFilePresent: true,
    expectedMigrated: false,
  },
  {
    label: "removes plaintext after gateway registration succeeds",
    registrationStatus: 0,
    settle: async (attempt: RegistrationAttempt) => {
      await expect(attempt).resolves.toEqual([
        { name: "legacy-openai", type: "generic", credentialEnv: "OPENAI_API_KEY" },
      ]);
    },
    expectedFilePresent: false,
    expectedMigrated: true,
  },
] as const;

async function finalizeMigration(
  stagedLegacyKeys: readonly string[],
  migratedLegacyKeys: ReadonlySet<string>,
): Promise<void> {
  await handleFinalizationState({
    sandboxName: "test-box",
    model: "gpt-5.4",
    provider: "openai-api",
    nimContainer: null,
    agent: {
      runtime: { kind: "terminal", interactive_command: "test-agent" },
    },
    hermesAuthMethod: null,
    hermesToolGateways: [],
    stagedLegacyKeys,
    migratedLegacyKeys,
    webSearchEnabled: false,
    webSearchProvider: null,
    deps: {
      ensureAgentDashboardForward: () => 0,
      persistDashboardPort: () => undefined,
      setDefaultSandbox: () => undefined,
      toSessionUpdates: (updates) => updates,
      removeLegacyCredentialsFile,
      cleanupStaleHostFiles: () => undefined,
      checkAndRecoverSandboxProcesses: () => undefined,
      settleOrdinaryOpenClawPairing: async () => ({ kind: "settled" }),
      ordinaryOpenClawPairingIncompleteMessage: () =>
        "OpenClaw onboarding is incomplete; resume onboarding.",
      readRegistryAgent: () => "openclaw",
      settlePortablePairing: async () => ({ kind: "settled" }),
      portablePairingIncompleteMessage: () =>
        "Portable onboarding is incomplete; resume onboarding.",
      getChatUiUrl: () => "",
      buildVerifyChain: () => null,
      verifyDeployment: async () => null,
      formatVerificationDiagnostics: () => [],
      isDeploymentHealthy: () => true,
      reportDeploymentReadiness: () => undefined,
      verifyWebSearchInsideSandbox: () => true,
      printDashboard: () => undefined,
      error: () => undefined,
      log: () => undefined,
    },
  });
}

describe("legacy credential reconciliation", () => {
  it.each(REGISTRATION_SCENARIOS)("$label (#7617)", async (scenario) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-credential-migration-"));
    const legacyDir = path.join(tmpDir, ".nemoclaw");
    const legacyFile = path.join(legacyDir, "credentials.json");
    fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({
        OPENAI_API_KEY: LEGACY_SECRET,
        OPENSHELL_GATEWAY: "tampered-gateway",
        NODE_OPTIONS: "--require=/tmp/tampered.js",
      }),
      { mode: 0o600 },
    );
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`gateway registration exited ${String(code)}`);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await withProcessEnv(
        {
          HOME: tmpDir,
          OPENAI_API_KEY: undefined,
          OPENSHELL_GATEWAY: "trusted-gateway",
          NODE_OPTIONS: "--enable-source-maps",
        },
        async () => {
          const stagedLegacyKeys = stageLegacyCredentialsToEnv();
          const stagedLegacyValues = new Map(
            stagedLegacyKeys.map((key) => [key, process.env[key] ?? ""]),
          );
          const migratedLegacyKeys = new Set<string>();
          const session = { stagedCredentialProviders: [] } as unknown as Session;
          const runOpenshell = vi.fn((args: string[], _options?: unknown) => ({
            status: args.slice(0, 2).join(" ") === "provider get" ? 1 : scenario.registrationStatus,
            stdout: "",
            stderr: scenario.registrationStatus === 0 ? "" : "registration failed",
          }));
          const deps: CredentialProviderRegistrationDeps = {
            root: path.join(import.meta.dirname, ".."),
            runOpenshell:
              runOpenshell as unknown as CredentialProviderRegistrationDeps["runOpenshell"],
            redact: (input) => input,
            getGatewayName: () => "nemoclaw",
            getCredential: (name) => process.env[name] ?? null,
            normalizeCredentialValue: (value) => (typeof value === "string" ? value.trim() : ""),
            updateSession: (mutator) => mutator(session) ?? session,
            stagedLegacyValues,
            migratedLegacyKeys,
            persistMigratedLegacyKeys: () => undefined,
          };
          const registration = createCredentialProviderRegistration(deps);
          const tokenDefs: MessagingTokenDef[] = [
            {
              name: "legacy-openai",
              envKey: "OPENAI_API_KEY",
              token: process.env.OPENAI_API_KEY ?? "",
            },
          ];

          await scenario.settle(
            registration.stageSandboxCredentialProviders(
              {
                sandboxName: "test-box",
                enabledChannels: [],
                webSearchConfig: null,
                agent: {},
                requiredBindings: [
                  {
                    name: "legacy-openai",
                    type: "generic",
                    credentialEnv: "OPENAI_API_KEY",
                  },
                ],
              },
              async () => ({ messagingTokenDefs: tokenDefs }),
            ),
          );

          await finalizeMigration(stagedLegacyKeys, migratedLegacyKeys);

          expect(stagedLegacyKeys).toEqual(["OPENAI_API_KEY"]);
          expect(process.env.OPENAI_API_KEY).toBe(LEGACY_SECRET);
          expect(process.env.OPENSHELL_GATEWAY).toBe("trusted-gateway");
          expect(process.env.NODE_OPTIONS).toBe("--enable-source-maps");
          expect(migratedLegacyKeys.has("OPENAI_API_KEY")).toBe(scenario.expectedMigrated);
          expect(runOpenshell.mock.calls.flatMap(([args]) => args)).not.toContain(LEGACY_SECRET);
          expect(runOpenshell.mock.calls.find(([args]) => args[1] === "create")?.[1]).toMatchObject(
            {
              env: { OPENAI_API_KEY: LEGACY_SECRET },
            },
          );
          expect(
            JSON.stringify(runOpenshell.mock.calls),
            "tampered non-credential fields must not reach gateway registration",
          ).not.toMatch(/tampered-gateway|tampered\.js/);
          expect(exit).toHaveBeenCalledTimes(scenario.registrationStatus);
          expect(
            fs.existsSync(legacyFile),
            scenario.expectedFilePresent
              ? "failed registration must preserve the legacy file"
              : "successful registration must remove the legacy file",
          ).toBe(scenario.expectedFilePresent);
        },
      );
    } finally {
      error.mockRestore();
      exit.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
