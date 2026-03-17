// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, execSync } from "node:child_process";
import type { PluginLogger, NemoClawConfig } from "../index.js";
import {
  loadOnboardConfig,
  saveOnboardConfig,
  type EndpointType,
  type NemoClawOnboardConfig,
} from "../onboard/config.js";
import { promptInput, promptConfirm, promptSelect } from "../onboard/prompt.js";
import { validateApiKey, maskApiKey } from "../onboard/validate.js";

export interface OnboardOptions {
  apiKey?: string;
  endpoint?: string;
  ncpPartner?: string;
  endpointUrl?: string;
  model?: string;
  logger: PluginLogger;
  pluginConfig: NemoClawConfig;
}

const ENDPOINT_TYPES: EndpointType[] = ["build", "ncp", "nim-local", "vllm", "ollama", "custom"];
const SUPPORTED_ENDPOINT_TYPES: EndpointType[] = ["build", "ncp"];

function isExperimentalEnabled(): boolean {
  return process.env.NEMOCLAW_EXPERIMENTAL === "1";
}

const BUILD_ENDPOINT_URL = "https://integrate.api.nvidia.com/v1";
const HOST_GATEWAY_URL = "http://host.openshell.internal";

const DEFAULT_MODELS = [
  { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B" },
  { id: "nvidia/llama-3.1-nemotron-ultra-253b-v1", label: "Nemotron Ultra 253B" },
  { id: "nvidia/llama-3.3-nemotron-super-49b-v1.5", label: "Nemotron Super 49B v1.5" },
  { id: "nvidia/nemotron-3-nano-30b-a3b", label: "Nemotron 3 Nano 30B" },
];

function resolveProfile(endpointType: EndpointType): string {
  switch (endpointType) {
    case "build":
      return "default";
    case "ncp":
    case "custom":
      return "ncp";
    case "nim-local":
      return "nim-local";
    case "vllm":
      return "vllm";
    case "ollama":
      return "ollama";
  }
}

function resolveProviderName(endpointType: EndpointType): string {
  switch (endpointType) {
    case "build":
      return "nvidia-nim";
    case "ncp":
    case "custom":
      return "nvidia-ncp";
    case "nim-local":
      return "nim-local";
    case "vllm":
      return "vllm-local";
    case "ollama":
      return "ollama-local";
  }
}

function resolveCredentialEnv(endpointType: EndpointType): string {
  switch (endpointType) {
    case "build":
    case "ncp":
    case "custom":
      return "NVIDIA_API_KEY";
    case "nim-local":
      return "NIM_API_KEY";
    case "vllm":
    case "ollama":
      return "OPENAI_API_KEY";
  }
}

function isNonInteractive(opts: OnboardOptions): boolean {
  if (!opts.endpoint || !opts.model) return false;
  const ep = opts.endpoint as EndpointType;
  if (endpointRequiresApiKey(ep) && !opts.apiKey) return false;
  if ((ep === "ncp" || ep === "nim-local" || ep === "custom") && !opts.endpointUrl) return false;
  if (ep === "ncp" && !opts.ncpPartner) return false;
  return true;
}

function endpointRequiresApiKey(endpointType: EndpointType): boolean {
  return (
    endpointType === "build" ||
    endpointType === "ncp" ||
    endpointType === "nim-local" ||
    endpointType === "custom"
  );
}

function defaultCredentialForEndpoint(endpointType: EndpointType): string {
  switch (endpointType) {
    case "vllm":
      return "dummy";
    case "ollama":
      return "ollama";
    default:
      return "";
  }
}

function detectOllama(): { installed: boolean; running: boolean } {
  const installed = testCommand("command -v ollama >/dev/null 2>&1");
  const running = testCommand("curl -sf http://localhost:11434/api/tags >/dev/null 2>&1");
  return { installed, running };
}

function testCommand(command: string): boolean {
  try {
    execSync(command, { encoding: "utf-8", stdio: "ignore", shell: "/bin/bash" });
    return true;
  } catch {
    return false;
  }
}

function showConfig(config: NemoClawOnboardConfig, logger: PluginLogger): void {
  logger.info(`  Endpoint:    ${config.endpointType} (${config.endpointUrl})`);
  if (config.ncpPartner) {
    logger.info(`  NCP Partner: ${config.ncpPartner}`);
  }
  logger.info(`  Model:       ${config.model}`);
  logger.info(`  Credential:  $${config.credentialEnv}`);
  logger.info(`  Profile:     ${config.profile}`);
  logger.info(`  Onboarded:   ${config.onboardedAt}`);
}

async function promptEndpoint(
  ollama: { installed: boolean; running: boolean },
): Promise<EndpointType> {
  const options = [
    {
      label: "NVIDIA Build (build.nvidia.com)",
      value: "build",
      hint: "recommended — zero infra, free credits",
    },
    {
      label: "NVIDIA Cloud Partner (NCP)",
      value: "ncp",
      hint: "dedicated capacity, SLA-backed",
    },
  ];

  if (isExperimentalEnabled()) {
    options.push(
      {
        label: "Self-hosted NIM [experimental]",
        value: "nim-local",
        hint: "experimental — your own NIM container deployment",
      },
      {
        label: "Local vLLM [experimental]",
        value: "vllm",
        hint: "experimental — local development",
      },
      {
        label: "Local Ollama [experimental]",
        value: "ollama",
        hint: `experimental — ${ollama.installed ? "installed locally" : "localhost:11434"}`,
      },
    );
  }

  return (await promptSelect("Select your inference endpoint:", options)) as EndpointType;
}

function execOpenShell(args: string[]): string {
  return execFileSync("openshell", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export async function cliOnboard(opts: OnboardOptions): Promise<void> {
  const { logger } = opts;
  const nonInteractive = isNonInteractive(opts);

  logger.info("NemoClaw Onboarding");
  logger.info("-------------------");

  // Step 0: Check existing config
  const existing = loadOnboardConfig();
  if (existing) {
    logger.info("");
    logger.info("Existing configuration found:");
    showConfig(existing, logger);
    logger.info("");

    if (!nonInteractive) {
      const reconfigure = await promptConfirm("Reconfigure?", false);
      if (!reconfigure) {
        logger.info("Keeping existing configuration.");
        return;
      }
    }
  }

  // Step 1: Endpoint Selection
  let endpointType: EndpointType;
  if (opts.endpoint) {
    if (!ENDPOINT_TYPES.includes(opts.endpoint as EndpointType)) {
      logger.error(
        `Invalid endpoint type: ${opts.endpoint}. Must be one of: ${ENDPOINT_TYPES.join(", ")}`,
      );
      return;
    }
    const ep = opts.endpoint as EndpointType;
    if (!SUPPORTED_ENDPOINT_TYPES.includes(ep)) {
      logger.warn(
        `Note: '${ep}' is experimental and may not work reliably.`,
      );
    }
    endpointType = ep;
  } else {
    const ollama = detectOllama();
    if (ollama.running && isExperimentalEnabled()) {
      logger.info("Detected Ollama on localhost:11434. Using it for onboarding.");
      endpointType = "ollama";
    } else {
      endpointType = await promptEndpoint(ollama);
    }
  }

  // Step 2: Endpoint URL resolution
  let endpointUrl: string;
  let ncpPartner: string | null = null;

  switch (endpointType) {
    case "build":
      endpointUrl = BUILD_ENDPOINT_URL;
      break;
    case "ncp":
      ncpPartner = opts.ncpPartner ?? (await promptInput("NCP partner name"));
      endpointUrl =
        opts.endpointUrl ??
        (await promptInput("NCP endpoint URL (e.g., https://partner.api.nvidia.com/v1)"));
      break;
    case "nim-local":
      endpointUrl =
        opts.endpointUrl ??
        (await promptInput("NIM endpoint URL", "http://nim-service.local:8000/v1"));
      break;
    case "vllm":
      endpointUrl = `${HOST_GATEWAY_URL}:8000/v1`;
      break;
    case "ollama":
      endpointUrl = opts.endpointUrl ?? `${HOST_GATEWAY_URL}:11434/v1`;
      break;
    case "custom":
      endpointUrl = opts.endpointUrl ?? (await promptInput("Custom endpoint URL"));
      break;
  }

  if (!endpointUrl) {
    logger.error("No endpoint URL provided. Aborting.");
    return;
  }

  const credentialEnv = resolveCredentialEnv(endpointType);
  const requiresApiKey = endpointRequiresApiKey(endpointType);

  // Step 3: Credential
  let apiKey = defaultCredentialForEndpoint(endpointType);
  if (requiresApiKey) {
    if (opts.apiKey) {
      apiKey = opts.apiKey;
    } else {
      const envKey = process.env.NVIDIA_API_KEY;
      if (envKey) {
        logger.info(`Detected NVIDIA_API_KEY in environment (${maskApiKey(envKey)})`);
        const useEnv = nonInteractive ? true : await promptConfirm("Use this key?");
        apiKey = useEnv ? envKey : await promptInput("Enter your NVIDIA API key");
      } else {
        logger.info("Get an API key from: https://build.nvidia.com/settings/api-keys");
        apiKey = await promptInput("Enter your NVIDIA API key");
      }
    }
  } else {
    logger.info(
      `No API key required for ${endpointType}. Using local credential value '${apiKey}'.`,
    );
  }

  if (!apiKey) {
    logger.error("No API key provided. Aborting.");
    return;
  }

  // Step 4: Validate API Key
  // For local endpoints (vllm, ollama, nim-local), validation is best-effort since the
  // service may not be running yet during onboarding.
  const isLocalEndpoint =
    endpointType === "vllm" || endpointType === "ollama" || endpointType === "nim-local";
  logger.info("");
  logger.info(`Validating ${requiresApiKey ? "credential" : "endpoint"} against ${endpointUrl}...`);
  const validation = await validateApiKey(apiKey, endpointUrl);

  if (!validation.valid) {
    if (isLocalEndpoint) {
      logger.warn(
        `Could not reach ${endpointUrl} (${validation.error ?? "unknown error"}). Continuing anyway — the service may not be running yet.`,
      );
    } else {
      logger.error(`API key validation failed: ${validation.error ?? "unknown error"}`);
      logger.info("Check your key at https://build.nvidia.com/settings/api-keys");
      return;
    }
  } else {
    logger.info(
      `${requiresApiKey ? "Credential" : "Endpoint"} valid. ${String(validation.models.length)} model(s) available.`,
    );
  }

  // Step 5: Model Selection
  let model: string;
  if (opts.model) {
    model = opts.model;
  } else {
    // Build model options: prefer Nemotron models from the endpoint, fall back to defaults
    const nemotronModels = validation.models.filter((m) => m.includes("nemotron"));
    const modelOptions =
      nemotronModels.length > 0
        ? nemotronModels.map((id) => ({ label: id, value: id }))
        : DEFAULT_MODELS.map((m) => ({ label: `${m.label} (${m.id})`, value: m.id }));

    model = await promptSelect("Select your primary model:", modelOptions);
  }

  // Step 6: Resolve profile
  const profile = resolveProfile(endpointType);
  const providerName = resolveProviderName(endpointType);

  // Step 7: Confirmation
  logger.info("");
  logger.info("Configuration summary:");
  logger.info(`  Endpoint:    ${endpointType} (${endpointUrl})`);
  if (ncpPartner) {
    logger.info(`  NCP Partner: ${ncpPartner}`);
  }
  logger.info(`  Model:       ${model}`);
  logger.info(
    `  API Key:     ${requiresApiKey ? maskApiKey(apiKey) : "not required (local provider)"}`,
  );
  logger.info(`  Credential:  $${credentialEnv}`);
  logger.info(`  Profile:     ${profile}`);
  logger.info(`  Provider:    ${providerName}`);
  logger.info("");

  if (!nonInteractive) {
    const proceed = await promptConfirm("Apply this configuration?");
    if (!proceed) {
      logger.info("Onboarding cancelled.");
      return;
    }
  }

  // Step 8: Apply
  logger.info("");
  logger.info("Applying configuration...");

  // 7a: Create/update provider
  try {
    execOpenShell([
      "provider",
      "create",
      "--name",
      providerName,
      "--type",
      "openai",
      "--credential",
      `${credentialEnv}=${apiKey}`,
      "--config",
      `OPENAI_BASE_URL=${endpointUrl}`,
    ]);
    logger.info(`Created provider: ${providerName}`);
  } catch (err) {
    const stderr =
      err instanceof Error && "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
    if (stderr.includes("AlreadyExists") || stderr.includes("already exists")) {
      try {
        execOpenShell([
          "provider",
          "update",
          providerName,
          "--credential",
          `${credentialEnv}=${apiKey}`,
          "--config",
          `OPENAI_BASE_URL=${endpointUrl}`,
        ]);
        logger.info(`Updated provider: ${providerName}`);
      } catch (updateErr) {
        const updateStderr =
          updateErr instanceof Error && "stderr" in updateErr
            ? String((updateErr as { stderr: unknown }).stderr)
            : "";
        logger.error(`Failed to update provider: ${updateStderr || String(updateErr)}`);
        return;
      }
    } else {
      logger.error(`Failed to create provider: ${stderr || String(err)}`);
      return;
    }
  }

  // 7b: Set inference route
  try {
    execOpenShell(["inference", "set", "--provider", providerName, "--model", model]);
    logger.info(`Inference route set: ${providerName} -> ${model}`);
  } catch (err) {
    const stderr =
      err instanceof Error && "stderr" in err ? String((err as { stderr: unknown }).stderr) : "";
    logger.error(`Failed to set inference route: ${stderr || String(err)}`);
    return;
  }

  // 7c: Save config
  saveOnboardConfig({
    endpointType,
    endpointUrl,
    ncpPartner,
    model,
    profile,
    credentialEnv,
    onboardedAt: new Date().toISOString(),
  });

  // Step 9: Success
  logger.info("");
  logger.info("Onboarding complete!");
  logger.info("");
  logger.info(`  Endpoint:   ${endpointUrl}`);
  logger.info(`  Model:      ${model}`);
  logger.info(`  Credential: $${credentialEnv}`);
  logger.info("");
  logger.info("Next steps:");
  logger.info("  openclaw nemoclaw launch     # Bootstrap sandbox");
  logger.info("  openclaw nemoclaw status     # Check configuration");
}
