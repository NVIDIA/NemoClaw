// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeCredentialValue, saveCredential } from "../credentials/store";
import type { ProbeRecovery } from "../validation-recovery";

export interface ValidationRecoveryPromptDeps {
  isNonInteractive(): boolean;
  prompt(question: string, options?: { secret?: boolean }): Promise<string>;
  validateNvidiaApiKeyValue(key: string, credentialEnv: string | null): string | null;
  getTransportRecoveryMessage(failure: any): string;
  exitOnboardFromPrompt(): never;
}

export interface ValidationRecoveryPromptHelpers {
  replaceNamedCredential(
    envName: string,
    label: string,
    helpUrl?: string | null,
    validator?: ((value: string) => string | null) | null,
  ): Promise<string>;
  promptValidationRecovery(
    label: string,
    recovery: ProbeRecovery,
    credentialEnv?: string | null,
    helpUrl?: string | null,
  ): Promise<"credential" | "selection" | "retry" | "model">;
}

export function createValidationRecoveryPromptHelpers(
  deps: ValidationRecoveryPromptDeps,
): ValidationRecoveryPromptHelpers {
  async function replaceNamedCredential(
    envName: string,
    label: string,
    helpUrl: string | null = null,
    validator: ((value: string) => string | null) | null = null,
  ): Promise<string> {
    if (helpUrl) {
      console.log("");
      console.log(`  Get your ${label} from: ${helpUrl}`);
      console.log("");
    }

    while (true) {
      const key = normalizeCredentialValue(await deps.prompt(`  ${label}: `, { secret: true }));
      if (!key) {
        console.error(`  ${label} is required.`);
        continue;
      }
      const validationError = typeof validator === "function" ? validator(key) : null;
      if (validationError) {
        console.error(validationError);
        continue;
      }
      saveCredential(envName, key);
      process.env[envName] = key;
      console.log("");
      console.log("  Credential staged. Onboarding will register it with the OpenShell gateway.");
      console.log("");
      return key;
    }
  }

  async function promptValidationRecovery(
    label: string,
    recovery: ProbeRecovery,
    credentialEnv: string | null = null,
    helpUrl: string | null = null,
  ): Promise<"credential" | "selection" | "retry" | "model"> {
    if (deps.isNonInteractive()) {
      process.exit(1);
    }

    if (recovery.kind === "credential" && credentialEnv) {
      console.log(
        `  ${label} authorization failed. Re-enter the API key or choose a different provider/model.`,
      );
      console.log("  ⚠️  Do NOT paste your API key here — use the options below:");
      const choice = (
        await deps.prompt("  Options: retry (re-enter key), back (change provider), exit [retry]: ", {
          secret: true,
        })
      )
        .trim()
        .toLowerCase();
      // Guard against the user accidentally pasting an API key at this prompt.
      // Tokens don't contain spaces; human sentences do — the no-space + length check
      // avoids false-positives on long typed sentences.
      const API_KEY_PREFIXES = ["nvapi-", "ghp_", "gcm-", "sk-", "gpt-", "gemini-", "nvcf-"];
      const looksLikeToken =
        API_KEY_PREFIXES.some((prefix) => choice.startsWith(prefix)) ||
        (!choice.includes(" ") && choice.length > 40) ||
        // Regex fallback: base64-safe token pattern (20+ chars, no spaces, mixed alphanum)
        /^[A-Za-z0-9_\-.]{20,}$/.test(choice);
      // validateNvidiaApiKeyValue is provider-aware: it only enforces the
      // nvapi- prefix when credentialEnv === "NVIDIA_API_KEY", so passing it
      // unconditionally here is safe for Anthropic/OpenAI/Gemini too.
      const validator = (key: string) => deps.validateNvidiaApiKeyValue(key, credentialEnv);
      if (looksLikeToken) {
        console.log("  ⚠️  That looks like an API key — do not paste credentials here.");
        console.log("  Treating as 'retry'. You will be prompted to enter the key securely.");
        await replaceNamedCredential(credentialEnv, `${label} API key`, helpUrl, validator);
        return "credential";
      }
      if (choice === "back") {
        console.log("  Returning to provider selection.");
        console.log("");
        return "selection";
      }
      if (choice === "exit" || choice === "quit") {
        deps.exitOnboardFromPrompt();
      }
      if (choice === "" || choice === "retry") {
        await replaceNamedCredential(credentialEnv, `${label} API key`, helpUrl, validator);
        return "credential";
      }
      console.log("  Please choose a provider/model again.");
      console.log("");
      return "selection";
    }

    if (recovery.kind === "transport") {
      console.log(deps.getTransportRecoveryMessage("failure" in recovery ? recovery.failure || {} : {}));
      const choice = (await deps.prompt("  Type 'retry', 'back', or 'exit' [retry]: "))
        .trim()
        .toLowerCase();
      if (choice === "back") {
        console.log("  Returning to provider selection.");
        console.log("");
        return "selection";
      }
      if (choice === "exit" || choice === "quit") {
        deps.exitOnboardFromPrompt();
      }
      if (choice === "" || choice === "retry") {
        console.log("");
        return "retry";
      }
      console.log("  Please choose a provider/model again.");
      console.log("");
      return "selection";
    }

    if (recovery.kind === "model") {
      console.log(`  Please enter a different ${label} model name.`);
      console.log("");
      return "model";
    }

    console.log("  Please choose a provider/model again.");
    console.log("");
    return "selection";
  }

  return { replaceNamedCredential, promptValidationRecovery };
}
