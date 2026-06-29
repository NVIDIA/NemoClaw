// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CurlProbeResult } from "../adapters/http/probe";
import { runCurlProbe } from "../adapters/http/probe";
import type { AgentDefinition } from "../agent/defs";
import { getCredential, normalizeCredentialValue, saveCredential } from "../credentials/store";
import type { WebSearchConfig } from "../inference/web-search";
import { BRAVE_API_KEY_ENV } from "../inference/web-search";
import { ROOT } from "../runner";
import { classifyValidationFailure } from "../validation";
import { getTransportRecoveryMessage } from "../validation-recovery";
import {
  BACK_TO_SELECTION,
  type BackToSelection,
  isBackToSelection,
} from "./credential-navigation";
import { exitOnboardFromPrompt, isAffirmativeAnswer } from "./prompt-helpers";
import type { ValidationFailureLike } from "./types";
import { agentSupportsWebSearch } from "./web-search-support";
import { verifyWebSearchInsideSandbox as verifyWebSearchInsideSandboxWithDeps } from "./web-search-verify";

const BRAVE_SEARCH_HELP_URL = "https://brave.com/search/api/";
const BRAVE_CURL_CONFIG_PREFIX = "nemoclaw-brave-probe";
const BRAVE_API_KEY_LINE_BREAK_MESSAGE = "Brave Search API key must not contain line breaks.";

export interface WebSearchFlowDeps {
  prompt(question: string, options?: { secret?: boolean }): Promise<string>;
  note(message: string): void;
  isNonInteractive(): boolean;
  cliName(): string;
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string | null;
}

export interface WebSearchFlowHelpers {
  validateBraveSearchApiKey(apiKey: string): CurlProbeResult;
  promptBraveSearchRecovery(validation: ValidationFailureLike): Promise<"retry" | "skip">;
  promptBraveSearchApiKey(): Promise<string | BackToSelection>;
  ensureValidatedBraveSearchCredential(
    nonInteractive?: boolean,
  ): Promise<string | BackToSelection | null>;
  configureWebSearch(
    existingConfig?: WebSearchConfig | null,
    agent?: AgentDefinition | null,
    dockerfilePathOverride?: string | null,
  ): Promise<WebSearchConfig | null>;
  verifyWebSearchInsideSandbox(
    sandboxName: string,
    agent: AgentDefinition | null | undefined,
  ): void;
}

export function createWebSearchFlowHelpers(deps: WebSearchFlowDeps): WebSearchFlowHelpers {
  function escapeCurlConfigValue(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function braveCurlConfig(apiKey: string): string {
    const tokenHeader = escapeCurlConfigValue(`X-Subscription-Token: ${apiKey}`);
    return [
      'header = "Accept: application/json"',
      'header = "Accept-Encoding: gzip"',
      `header = "${tokenHeader}"`,
      "",
    ].join("\n");
  }

  function writeBraveCurlConfig(apiKey: string): { configPath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${BRAVE_CURL_CONFIG_PREFIX}-`));
    const configPath = path.join(dir, "curl.conf");
    try {
      fs.writeFileSync(configPath, braveCurlConfig(apiKey), { mode: 0o600 });
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    return {
      configPath,
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  }

  function braveSearchArgs(configPath: string): string[] {
    return [
      "-sS",
      "--compressed",
      "--config",
      configPath,
      "--get",
      "--data-urlencode",
      "q=ping",
      "--data-urlencode",
      "count=1",
      "https://api.search.brave.com/res/v1/web/search",
    ];
  }

  function invalidBraveSearchApiKey(message: string): CurlProbeResult {
    return {
      ok: false,
      httpStatus: 0,
      curlStatus: 0,
      body: "",
      stderr: "",
      message,
    };
  }

  function validateBraveSearchApiKey(apiKey: string): CurlProbeResult {
    if (/[\r\n]/.test(apiKey)) {
      return invalidBraveSearchApiKey(BRAVE_API_KEY_LINE_BREAK_MESSAGE);
    }
    const { configPath, cleanup } = writeBraveCurlConfig(apiKey);
    try {
      return runCurlProbe(braveSearchArgs(configPath), { trustedConfigFiles: [configPath] });
    } finally {
      cleanup();
    }
  }

  async function promptBraveSearchRecovery(
    validation: ValidationFailureLike,
  ): Promise<"retry" | "skip"> {
    const recovery = classifyValidationFailure(validation);

    if (recovery.kind === "credential") {
      console.log("  Brave Search rejected that API key.");
    } else if (recovery.kind === "transport") {
      console.log(getTransportRecoveryMessage(validation));
    } else {
      console.log("  Brave Search validation did not succeed.");
    }

    const answer = (await deps.prompt("  Type 'retry', 'skip', or 'exit' [retry]: "))
      .trim()
      .toLowerCase();
    if (answer === "skip") return "skip";
    if (answer === "exit" || answer === "quit") {
      exitOnboardFromPrompt();
    }
    return "retry";
  }

  async function promptBraveSearchApiKey(): Promise<string | BackToSelection> {
    console.log("");
    console.log(`  Get your Brave Search API key from: ${BRAVE_SEARCH_HELP_URL}`);
    console.log("");

    while (true) {
      const value = await deps.prompt("  Brave Search API key: ", { secret: true });
      const intent = normalizeCredentialValue(value).toLowerCase();
      if (intent === "back") return BACK_TO_SELECTION;
      if (intent === "exit" || intent === "quit") {
        exitOnboardFromPrompt();
      }
      if (intent === "?" || intent === "help") {
        console.log("  Type back to choose again, or exit to quit.");
        continue;
      }
      const key = normalizeCredentialValue(value);
      if (!key) {
        console.error("  Brave Search API key is required.");
        continue;
      }
      return key;
    }
  }

  async function ensureValidatedBraveSearchCredential(
    nonInteractive = deps.isNonInteractive(),
  ): Promise<string | BackToSelection | null> {
    const savedApiKey = getCredential(BRAVE_API_KEY_ENV);
    let apiKey: string | null =
      savedApiKey || normalizeCredentialValue(process.env[BRAVE_API_KEY_ENV]);
    let usingSavedKey = Boolean(savedApiKey);

    while (true) {
      if (!apiKey) {
        if (nonInteractive) {
          throw new Error(
            "Brave Search requires BRAVE_API_KEY or a saved Brave Search credential in non-interactive mode.",
          );
        }
        const promptedApiKey = await promptBraveSearchApiKey();
        if (isBackToSelection(promptedApiKey)) {
          return promptedApiKey;
        }
        apiKey = promptedApiKey;
        usingSavedKey = false;
      }

      const validation = validateBraveSearchApiKey(apiKey);
      if (validation.ok) {
        saveCredential(BRAVE_API_KEY_ENV, apiKey);
        process.env[BRAVE_API_KEY_ENV] = apiKey;
        return apiKey;
      }

      const prefix = usingSavedKey
        ? "  Saved Brave Search API key validation failed."
        : "  Brave Search API key validation failed.";
      console.error(prefix);
      if (validation.message) {
        console.error(`  ${validation.message}`);
      }

      if (nonInteractive) {
        throw new Error(
          validation.message || "Brave Search API key validation failed in non-interactive mode.",
        );
      }

      const action = await promptBraveSearchRecovery(validation);
      if (action === "skip") {
        console.log("  Skipping Brave Web Search setup.");
        console.log("");
        return null;
      }

      apiKey = null;
      usingSavedKey = false;
    }
  }

  async function configureWebSearch(
    existingConfig: WebSearchConfig | null = null,
    agent: AgentDefinition | null = null,
    dockerfilePathOverride: string | null = null,
  ): Promise<WebSearchConfig | null> {
    if (!agentSupportsWebSearch(agent, dockerfilePathOverride, ROOT)) {
      deps.note(
        `  Web search is not yet supported by ${agent?.displayName ?? "this agent"}. Skipping.`,
      );
      return null;
    }

    if (existingConfig) {
      return { fetchEnabled: true };
    }

    if (deps.isNonInteractive()) {
      const braveApiKey =
        getCredential(BRAVE_API_KEY_ENV) ||
        normalizeCredentialValue(process.env[BRAVE_API_KEY_ENV]);
      if (!braveApiKey) {
        return null;
      }
      deps.note("  [non-interactive] Brave Web Search requested.");
      const validation = validateBraveSearchApiKey(braveApiKey);
      if (!validation.ok) {
        console.warn(
          `  Brave Search API key validation failed. Web search will be disabled — re-enable later via \`${deps.cliName()} config web-search\`.`,
        );
        if (validation.message) {
          console.warn(`  ${validation.message}`);
        }
        return null;
      }
      saveCredential(BRAVE_API_KEY_ENV, braveApiKey);
      process.env[BRAVE_API_KEY_ENV] = braveApiKey;
      return { fetchEnabled: true };
    }
    const enableAnswer = await deps.prompt("  Enable Brave Web Search? [y/N]: ");
    if (!isAffirmativeAnswer(enableAnswer)) {
      return null;
    }

    const braveApiKey = await ensureValidatedBraveSearchCredential();
    if (isBackToSelection(braveApiKey)) {
      return configureWebSearch(existingConfig, agent, dockerfilePathOverride);
    }
    if (!braveApiKey) {
      return null;
    }

    console.log("  ✓ Enabled Brave Web Search");
    console.log("");
    return { fetchEnabled: true };
  }

  function verifyWebSearchInsideSandbox(
    sandboxName: string,
    agent: AgentDefinition | null | undefined,
  ): void {
    verifyWebSearchInsideSandboxWithDeps(sandboxName, agent, {
      runCaptureOpenshell: deps.runCaptureOpenshell,
      cliName: deps.cliName,
    });
  }

  return {
    validateBraveSearchApiKey,
    promptBraveSearchRecovery,
    promptBraveSearchApiKey,
    ensureValidatedBraveSearchCredential,
    configureWebSearch,
    verifyWebSearchInsideSandbox,
  };
}
