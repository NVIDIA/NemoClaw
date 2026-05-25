// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeCredentialValue } from "../credentials/store";
import type { HermesAuthMethod } from "../hermes-provider-auth";
import * as hermesProviderAuth from "../hermes-provider-auth";

export type { HermesAuthMethod };

export const HERMES_AUTH_METHOD_OAUTH: HermesAuthMethod = "oauth";
export const HERMES_AUTH_METHOD_API_KEY: HermesAuthMethod = "api_key";
export const HERMES_NOUS_API_KEY_CREDENTIAL_ENV =
  hermesProviderAuth.HERMES_NOUS_API_KEY_CREDENTIAL_ENV || "NOUS_API_KEY";
export const HERMES_NOUS_API_KEY_HELP_URL = "https://portal.nousresearch.com/manage-subscription";

export function normalizeHermesAuthMethod(value: string | null | undefined): HermesAuthMethod | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!normalized) return null;
  if (normalized === "oauth" || normalized === "nous_oauth" || normalized === "nous_portal_oauth") {
    return HERMES_AUTH_METHOD_OAUTH;
  }
  if (
    normalized === "api" ||
    normalized === "key" ||
    normalized === "api_key" ||
    normalized === "apikey" ||
    normalized === "nous_api_key"
  ) {
    return HERMES_AUTH_METHOD_API_KEY;
  }
  return null;
}

export function hermesAuthMethodLabel(method: HermesAuthMethod | null | undefined): string {
  return method === HERMES_AUTH_METHOD_API_KEY ? "Nous API Key" : "Nous Portal OAuth";
}

export function getRequestedHermesAuthMethod(): HermesAuthMethod | null {
  const raw =
    process.env.NEMOCLAW_HERMES_AUTH_METHOD ||
    process.env.NEMOCLAW_HERMES_AUTH ||
    process.env.NEMOCLAW_NOUS_AUTH_METHOD ||
    "";
  const method = normalizeHermesAuthMethod(raw);
  if (!raw || method) return method;
  console.error(`  Unsupported Hermes Provider auth method: ${raw}`);
  console.error("  Valid values: oauth, nous-portal-oauth, api-key, nous-api-key");
  process.exit(1);
}

export interface HermesAuthFlowDeps {
  isNonInteractive(): boolean;
  note(message: string): void;
  prompt(question: string, options?: { secret?: boolean }): Promise<string>;
  getNavigationChoice(value?: string): "back" | "exit" | null;
  exitOnboardFromPrompt(): never;
  validateNvidiaApiKeyValue(value: string, envName: string): string | null;
  compactText(value: string): string;
  redact(value: unknown): string;
  runOpenshell(args: string[], opts?: Record<string, unknown>): {
    status?: number | null;
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
  };
  backToSelection: unknown;
}

export interface HermesAuthHelpers {
  promptHermesAuthMethod(): Promise<HermesAuthMethod | unknown>;
  resolveHermesNousApiKey(): string | null;
  stageNousApiKeyProviderEnv(): void;
  ensureHermesNousApiKeyEnv(): Promise<string | unknown>;
  openshellResultMessage(result: {
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
  }): string;
  checkHermesProviderStoreReachable(
    runOpenshellImpl?: HermesAuthFlowDeps["runOpenshell"],
  ): { ok: true } | { ok: false; message: string };
}

export function createHermesAuthHelpers(deps: HermesAuthFlowDeps): HermesAuthHelpers {
  async function promptHermesAuthMethod(): Promise<HermesAuthMethod | unknown> {
    const methods: Array<{ key: HermesAuthMethod; label: string }> = [
      { key: HERMES_AUTH_METHOD_OAUTH, label: "Nous Portal OAuth (authenticate via browser)" },
      {
        key: HERMES_AUTH_METHOD_API_KEY,
        label: "Nous API Key (paste a key from the provider dashboard)",
      },
    ];
    const requested = getRequestedHermesAuthMethod();
    if (deps.isNonInteractive()) {
      const method =
        requested ||
        (resolveHermesNousApiKey()
          ? HERMES_AUTH_METHOD_API_KEY
          : HERMES_AUTH_METHOD_OAUTH);
      deps.note(`  [non-interactive] Hermes auth: ${hermesAuthMethodLabel(method)}`);
      return method;
    }

    console.log("");
    console.log("  Hermes Provider authentication:");
    methods.forEach((method, index) => {
      console.log(`    ${index + 1}) ${method.label}`);
    });
    console.log("");

    const defaultIdx = (requested ? methods.findIndex((method) => method.key === requested) : 0) + 1;
    const choice = await deps.prompt(`  Choose [${defaultIdx}]: `);
    const navigation = deps.getNavigationChoice(choice);
    if (navigation === "back") return deps.backToSelection;
    if (navigation === "exit") deps.exitOnboardFromPrompt();
    const idx = parseInt(choice || String(defaultIdx), 10) - 1;
    return methods[idx]?.key || methods[defaultIdx - 1]?.key || HERMES_AUTH_METHOD_OAUTH;
  }

  function resolveHermesNousApiKey(): string | null {
    return (
      // check-direct-credential-env-ignore -- Hermes Provider API keys are read only from the invoking shell for OpenShell provider registration; do not resolve host credentials.json.
      normalizeCredentialValue(process.env[HERMES_NOUS_API_KEY_CREDENTIAL_ENV]) ||
      normalizeCredentialValue(process.env.NEMOCLAW_PROVIDER_KEY) ||
      null
    );
  }

  function stageNousApiKeyProviderEnv(): void {
    const key = resolveHermesNousApiKey();
    if (key) {
      process.env[HERMES_NOUS_API_KEY_CREDENTIAL_ENV] = key;
    }
  }

  async function ensureHermesNousApiKeyEnv(): Promise<string | unknown> {
    const existing = resolveHermesNousApiKey();
    if (existing) {
      process.env[HERMES_NOUS_API_KEY_CREDENTIAL_ENV] = existing;
      return existing;
    }
    console.log("");
    console.log("  Hermes Provider Nous API Key");
    console.log(`  Create or copy a key from ${HERMES_NOUS_API_KEY_HELP_URL}`);
    const rawKey = await deps.prompt("  Nous API Key: ", {
      secret: true,
    });
    const navigation = deps.getNavigationChoice(rawKey);
    if (navigation === "back") return deps.backToSelection;
    if (navigation === "exit") deps.exitOnboardFromPrompt();
    const key = normalizeCredentialValue(rawKey);
    const validationError = deps.validateNvidiaApiKeyValue(key, HERMES_NOUS_API_KEY_CREDENTIAL_ENV);
    if (validationError) {
      console.error(validationError);
      process.exit(1);
    }
    process.env[HERMES_NOUS_API_KEY_CREDENTIAL_ENV] = key;
    return key;
  }

  function openshellResultMessage(result: {
    stdout?: string | Buffer | null;
    stderr?: string | Buffer | null;
  }): string {
    return deps.compactText(deps.redact(`${result.stderr || ""} ${result.stdout || ""}`));
  }

  function checkHermesProviderStoreReachable(
    runOpenshellImpl: HermesAuthFlowDeps["runOpenshell"] = deps.runOpenshell,
  ): { ok: true } | { ok: false; message: string } {
    const result = runOpenshellImpl(["provider", "list"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    if (result.status === 0) return { ok: true };
    return {
      ok: false,
      message:
        openshellResultMessage(result) ||
        "OpenShell provider storage is unreachable; the gateway may be stopped or refusing connections.",
    };
  }

  return {
    promptHermesAuthMethod,
    resolveHermesNousApiKey,
    stageNousApiKeyProviderEnv,
    ensureHermesNousApiKeyEnv,
    openshellResultMessage,
    checkHermesProviderStoreReachable,
  };
}
