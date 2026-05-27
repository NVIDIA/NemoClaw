// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CurlProbeResult } from "../adapters/http/probe";
import { runCurlProbe } from "../adapters/http/probe";
import type { AgentDefinition } from "../agent/defs";
import { getCredential, normalizeCredentialValue, saveCredential } from "../credentials/store";
import type { WebSearchConfig, WebSearchProvider } from "../inference/web-search";
import {
  BRAVE_API_KEY_ENV,
  TAVILY_API_KEY_ENV,
  WEB_SEARCH_PROVIDER_ENV,
  webSearchUsageMessage,
} from "../inference/web-search";
import { ROOT } from "../runner";
import { classifyValidationFailure } from "../validation";
import { getTransportRecoveryMessage } from "../validation-recovery";
import { BACK_TO_SELECTION, type BackToSelection, isBackToSelection } from "./credential-navigation";
import { exitOnboardFromPrompt, isAffirmativeAnswer } from "./prompt-helpers";
import type { ValidationFailureLike } from "./types";
import { agentSupportsWebSearch } from "./web-search-support";
import { verifyWebSearchInsideSandbox as verifyWebSearchInsideSandboxWithDeps } from "./web-search-verify";

const BRAVE_SEARCH_HELP_URL = "https://brave.com/search/api/";
const TAVILY_SEARCH_HELP_URL = "https://tavily.com";

export interface WebSearchFlowDeps {
  prompt(question: string, options?: { secret?: boolean }): Promise<string>;
  note(message: string): void;
  isNonInteractive(): boolean;
  cliName(): string;
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string | null;
}

export interface WebSearchFlowHelpers {
  validateBraveSearchApiKey(apiKey: string): CurlProbeResult;
  validateTavilySearchApiKey(apiKey: string): CurlProbeResult;
  promptBraveSearchRecovery(validation: ValidationFailureLike): Promise<"retry" | "skip">;
  promptTavilySearchRecovery(validation: ValidationFailureLike): Promise<"retry" | "skip">;
  promptBraveSearchApiKey(): Promise<string | BackToSelection>;
  promptTavilySearchApiKey(): Promise<string | BackToSelection>;
  ensureValidatedBraveSearchCredential(nonInteractive?: boolean): Promise<string | BackToSelection | null>;
  ensureValidatedTavilySearchCredential(nonInteractive?: boolean): Promise<string | BackToSelection | null>;
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

function resolveNonInteractiveWebSearchProvider(): WebSearchProvider | null {
  const explicit = normalizeCredentialValue(process.env[WEB_SEARCH_PROVIDER_ENV]).toLowerCase();
  if (explicit === "tavily" || explicit === "brave") {
    return explicit;
  }
  const tavilyKey =
    getCredential(TAVILY_API_KEY_ENV) || normalizeCredentialValue(process.env[TAVILY_API_KEY_ENV]);
  const braveKey =
    getCredential(BRAVE_API_KEY_ENV) || normalizeCredentialValue(process.env[BRAVE_API_KEY_ENV]);
  if (tavilyKey && !braveKey) return "tavily";
  if (braveKey) return "brave";
  if (tavilyKey) return "tavily";
  return null;
}

export function createWebSearchFlowHelpers(deps: WebSearchFlowDeps): WebSearchFlowHelpers {
  function validateBraveSearchApiKey(apiKey: string): CurlProbeResult {
    return runCurlProbe([
      "-sS",
      "--compressed",
      "-H",
      "Accept: application/json",
      "-H",
      "Accept-Encoding: gzip",
      "-H",
      `X-Subscription-Token: ${apiKey}`,
      "--get",
      "--data-urlencode",
      "q=ping",
      "--data-urlencode",
      "count=1",
      "https://api.search.brave.com/res/v1/web/search",
    ]);
  }

  function validateTavilySearchApiKey(apiKey: string): CurlProbeResult {
    return runCurlProbe([
      "-sS",
      "-H",
      "Content-Type: application/json",
      "-d",
      JSON.stringify({ api_key: apiKey, query: "ping", max_results: 1 }),
      "https://api.tavily.com/search",
    ]);
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

    const answer = (await deps.prompt("  Type 'retry', 'skip', or 'exit' [retry]: ")).trim().toLowerCase();
    if (answer === "skip") return "skip";
    if (answer === "exit" || answer === "quit") {
      exitOnboardFromPrompt();
    }
    return "retry";
  }

  async function promptTavilySearchRecovery(
    validation: ValidationFailureLike,
  ): Promise<"retry" | "skip"> {
    const recovery = classifyValidationFailure(validation);

    if (recovery.kind === "credential") {
      console.log("  Tavily Search rejected that API key.");
    } else if (recovery.kind === "transport") {
      console.log(getTransportRecoveryMessage(validation));
    } else {
      console.log("  Tavily Search validation did not succeed.");
    }

    const answer = (await deps.prompt("  Type 'retry', 'skip', or 'exit' [retry]: ")).trim().toLowerCase();
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

  async function promptTavilySearchApiKey(): Promise<string | BackToSelection> {
    console.log("");
    console.log(`  Get your Tavily Search API key from: ${TAVILY_SEARCH_HELP_URL}`);
    console.log("");

    while (true) {
      const value = await deps.prompt("  Tavily Search API key: ", { secret: true });
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
        console.error("  Tavily Search API key is required.");
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

  async function ensureValidatedTavilySearchCredential(
    nonInteractive = deps.isNonInteractive(),
  ): Promise<string | BackToSelection | null> {
    const savedApiKey = getCredential(TAVILY_API_KEY_ENV);
    let apiKey: string | null =
      savedApiKey || normalizeCredentialValue(process.env[TAVILY_API_KEY_ENV]);
    let usingSavedKey = Boolean(savedApiKey);

    while (true) {
      if (!apiKey) {
        if (nonInteractive) {
          throw new Error(
            "Tavily Search requires TAVILY_API_KEY or a saved Tavily Search credential in non-interactive mode.",
          );
        }
        const promptedApiKey = await promptTavilySearchApiKey();
        if (isBackToSelection(promptedApiKey)) {
          return promptedApiKey;
        }
        apiKey = promptedApiKey;
        usingSavedKey = false;
      }

      const validation = validateTavilySearchApiKey(apiKey);
      if (validation.ok) {
        saveCredential(TAVILY_API_KEY_ENV, apiKey);
        process.env[TAVILY_API_KEY_ENV] = apiKey;
        return apiKey;
      }

      const prefix = usingSavedKey
        ? "  Saved Tavily Search API key validation failed."
        : "  Tavily Search API key validation failed.";
      console.error(prefix);
      if (validation.message) {
        console.error(`  ${validation.message}`);
      }

      if (nonInteractive) {
        throw new Error(
          validation.message || "Tavily Search API key validation failed in non-interactive mode.",
        );
      }

      const action = await promptTavilySearchRecovery(validation);
      if (action === "skip") {
        console.log("  Skipping Tavily Web Search setup.");
        console.log("");
        return null;
      }

      apiKey = null;
      usingSavedKey = false;
    }
  }

  async function promptWebSearchProvider(): Promise<WebSearchProvider | BackToSelection> {
    console.log("");
    console.log("  Web search provider:");
    console.log("    1) Brave Search");
    console.log("    2) Tavily Search");
    console.log("");

    while (true) {
      const answer = (await deps.prompt("  Choose provider [1]: ")).trim().toLowerCase();
      if (answer === "" || answer === "1" || answer === "brave") return "brave";
      if (answer === "2" || answer === "tavily") return "tavily";
      if (answer === "back") return BACK_TO_SELECTION;
      if (answer === "exit" || answer === "quit") {
        exitOnboardFromPrompt();
      }
      console.error("  Enter 1 for Brave, 2 for Tavily, back, or exit.");
    }
  }

  async function configureWebSearch(
    existingConfig: WebSearchConfig | null = null,
    agent: AgentDefinition | null = null,
    dockerfilePathOverride: string | null = null,
  ): Promise<WebSearchConfig | null> {
    if (!agentSupportsWebSearch(agent, dockerfilePathOverride, ROOT)) {
      deps.note(`  Web search is not yet supported by ${agent?.displayName ?? "this agent"}. Skipping.`);
      return null;
    }

    if (existingConfig?.fetchEnabled) {
      return {
        fetchEnabled: true,
        provider: existingConfig.provider === "tavily" ? "tavily" : "brave",
      };
    }

    if (deps.isNonInteractive()) {
      const provider = resolveNonInteractiveWebSearchProvider();
      if (!provider) {
        return null;
      }

      if (provider === "brave") {
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
        process.env[WEB_SEARCH_PROVIDER_ENV] = "brave";
        const usageMsg = webSearchUsageMessage({ fetchEnabled: true, provider: "brave" });
        if (usageMsg) {
          console.log(`  ${usageMsg}`);
        }
        return { fetchEnabled: true, provider: "brave" };
      }

      const tavilyApiKey =
        getCredential(TAVILY_API_KEY_ENV) ||
        normalizeCredentialValue(process.env[TAVILY_API_KEY_ENV]);
      if (!tavilyApiKey) {
        return null;
      }
      deps.note("  [non-interactive] Tavily Web Search requested.");
      const validation = validateTavilySearchApiKey(tavilyApiKey);
      if (!validation.ok) {
        console.warn(
          `  Tavily Search API key validation failed. Web search will be disabled — re-enable later via \`${deps.cliName()} config web-search\`.`,
        );
        if (validation.message) {
          console.warn(`  ${validation.message}`);
        }
        return null;
      }
      saveCredential(TAVILY_API_KEY_ENV, tavilyApiKey);
      process.env[TAVILY_API_KEY_ENV] = tavilyApiKey;
      process.env[WEB_SEARCH_PROVIDER_ENV] = "tavily";
      const usageMsg = webSearchUsageMessage({ fetchEnabled: true, provider: "tavily" });
      if (usageMsg) {
        console.log(`  ${usageMsg}`);
      }
      return { fetchEnabled: true, provider: "tavily" };
    }

    const enableAnswer = await deps.prompt("  Enable web search? [y/N]: ");
    if (!isAffirmativeAnswer(enableAnswer)) {
      return null;
    }

    let provider = await promptWebSearchProvider();
    if (isBackToSelection(provider)) {
      return configureWebSearch(existingConfig, agent, dockerfilePathOverride);
    }

    while (true) {
      const apiKey =
        provider === "tavily"
          ? await ensureValidatedTavilySearchCredential()
          : await ensureValidatedBraveSearchCredential();

      if (isBackToSelection(apiKey)) {
        provider = await promptWebSearchProvider();
        if (isBackToSelection(provider)) {
          return configureWebSearch(existingConfig, agent, dockerfilePathOverride);
        }
        continue;
      }
      if (!apiKey) {
        return null;
      }

      process.env[WEB_SEARCH_PROVIDER_ENV] = provider;
      if (provider === "tavily") {
        console.log("  ✓ Enabled Tavily Web Search");
      } else {
        console.log("  ✓ Enabled Brave Web Search");
      }
      const usageMsg = webSearchUsageMessage({ fetchEnabled: true, provider });
      if (usageMsg) {
        console.log(`  ${usageMsg}`);
      }
      console.log("");
      return { fetchEnabled: true, provider };
    }
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
    validateTavilySearchApiKey,
    promptBraveSearchRecovery,
    promptTavilySearchRecovery,
    promptBraveSearchApiKey,
    promptTavilySearchApiKey,
    ensureValidatedBraveSearchCredential,
    ensureValidatedTavilySearchCredential,
    configureWebSearch,
    verifyWebSearchInsideSandbox,
  };
}
