"use strict";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
Object.defineProperty(exports, "__esModule", { value: true });
exports.cliOnboard = cliOnboard;
const node_child_process_1 = require("node:child_process");
const config_js_1 = require("../onboard/config.js");
const prompt_js_1 = require("../onboard/prompt.js");
const validate_js_1 = require("../onboard/validate.js");
const ENDPOINT_TYPES = ["build", "ncp", "nim-local", "vllm", "ollama", "baseten", "custom"];
const SUPPORTED_ENDPOINT_TYPES = ["build", "ncp", "baseten"];
function isExperimentalEnabled() {
    return process.env.NEMOCLAW_EXPERIMENTAL === "1";
}
const BUILD_ENDPOINT_URL = "https://integrate.api.nvidia.com/v1";
const HOST_GATEWAY_URL = "http://host.openshell.internal";
const BASETEN_MODELS = [
    { id: "zai-org/GLM-5", label: "GLM-5" },
    { id: "zai-org/GLM-4.7", label: "GLM-4.7" },
    { id: "zai-org/GLM-4.6", label: "GLM-4.6" },
    { id: "deepseek-ai/DeepSeek-V3.1", label: "DeepSeek V3.1" },
    { id: "deepseek-ai/DeepSeek-V3-0324", label: "DeepSeek V3 0324" },
    { id: "moonshotai/Kimi-K2.5", label: "Kimi K2.5" },
    { id: "MiniMaxAI/MiniMax-M2.5", label: "MiniMax M2.5" },
    { id: "nvidia/Nemotron-120B-A12B", label: "Nemotron Super 120B" },
    { id: "openai/gpt-oss-120b", label: "OpenAI GPT OSS 120B" },
];
const DEFAULT_MODELS = [
    { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B" },
    { id: "nvidia/llama-3.1-nemotron-ultra-253b-v1", label: "Nemotron Ultra 253B" },
    { id: "nvidia/llama-3.3-nemotron-super-49b-v1.5", label: "Nemotron Super 49B v1.5" },
    { id: "nvidia/nemotron-3-nano-30b-a3b", label: "Nemotron 3 Nano 30B" },
];
function resolveProfile(endpointType) {
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
        case "baseten":
            return "baseten";
    }
}
function resolveProviderName(endpointType) {
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
        case "baseten":
            return "baseten";
    }
}
function resolveCredentialEnv(endpointType) {
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
        case "baseten":
            return "BASETEN_API_KEY";
    }
}
function isNonInteractive(opts) {
    if (!opts.endpoint || !opts.model)
        return false;
    const ep = opts.endpoint;
    const envApiKey = process.env[resolveCredentialEnv(ep)];
    if (endpointRequiresApiKey(ep) && !opts.apiKey && !envApiKey)
        return false;
    if ((ep === "ncp" || ep === "nim-local" || ep === "custom") && !opts.endpointUrl)
        return false;
    if (ep === "ncp" && !opts.ncpPartner)
        return false;
    return true;
}
function endpointRequiresApiKey(endpointType) {
    return (endpointType === "build" ||
        endpointType === "ncp" ||
        endpointType === "nim-local" ||
        endpointType === "baseten" ||
        endpointType === "custom");
}
function defaultCredentialForEndpoint(endpointType) {
    switch (endpointType) {
        case "vllm":
            return "dummy";
        case "ollama":
            return "ollama";
        default:
            return "";
    }
}
function detectOllama() {
    const installed = testCommand("command -v ollama >/dev/null 2>&1");
    const running = testCommand("curl -sf http://localhost:11434/api/tags >/dev/null 2>&1");
    return { installed, running };
}
function testCommand(command) {
    try {
        (0, node_child_process_1.execSync)(command, { encoding: "utf-8", stdio: "ignore", shell: "/bin/bash" });
        return true;
    }
    catch {
        return false;
    }
}
function showConfig(config, logger) {
    logger.info(`  Endpoint:    ${config.endpointType} (${config.endpointUrl})`);
    if (config.ncpPartner) {
        logger.info(`  NCP Partner: ${config.ncpPartner}`);
    }
    logger.info(`  Model:       ${config.model}`);
    logger.info(`  Credential:  $${config.credentialEnv}`);
    logger.info(`  Profile:     ${config.profile}`);
    logger.info(`  Onboarded:   ${config.onboardedAt}`);
}
async function promptEndpoint(ollama) {
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
        {
            label: "Baseten",
            value: "baseten",
            hint: "third-party — inference.baseten.co",
        },
    ];
    if (isExperimentalEnabled()) {
        options.push({
            label: "Self-hosted NIM [experimental]",
            value: "nim-local",
            hint: "experimental — your own NIM container deployment",
        }, {
            label: "Local vLLM [experimental]",
            value: "vllm",
            hint: "experimental — local development",
        }, {
            label: "Local Ollama [experimental]",
            value: "ollama",
            hint: `experimental — ${ollama.installed ? "installed locally" : "localhost:11434"}`,
        });
    }
    return (await (0, prompt_js_1.promptSelect)("Select your inference endpoint:", options));
}
function execOpenShell(args) {
    return (0, node_child_process_1.execFileSync)("openshell", args, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
    });
}
async function cliOnboard(opts) {
    const { logger } = opts;
    const nonInteractive = isNonInteractive(opts);
    logger.info("NemoClaw Onboarding");
    logger.info("-------------------");
    // Step 0: Check existing config
    const existing = (0, config_js_1.loadOnboardConfig)();
    if (existing) {
        logger.info("");
        logger.info("Existing configuration found:");
        showConfig(existing, logger);
        logger.info("");
        if (!nonInteractive) {
            const reconfigure = await (0, prompt_js_1.promptConfirm)("Reconfigure?", false);
            if (!reconfigure) {
                logger.info("Keeping existing configuration.");
                return;
            }
        }
    }
    // Step 1: Endpoint Selection
    let endpointType;
    if (opts.endpoint) {
        if (!ENDPOINT_TYPES.includes(opts.endpoint)) {
            logger.error(`Invalid endpoint type: ${opts.endpoint}. Must be one of: ${ENDPOINT_TYPES.join(", ")}`);
            return;
        }
        const ep = opts.endpoint;
        if (!SUPPORTED_ENDPOINT_TYPES.includes(ep)) {
            logger.warn(`Note: '${ep}' is experimental and may not work reliably.`);
        }
        endpointType = ep;
    }
    else {
        const ollama = detectOllama();
        if (ollama.running && isExperimentalEnabled()) {
            logger.info("Detected Ollama on localhost:11434. Using it for onboarding.");
            endpointType = "ollama";
        }
        else {
            endpointType = await promptEndpoint(ollama);
        }
    }
    // Step 2: Endpoint URL resolution
    let endpointUrl;
    let ncpPartner = null;
    switch (endpointType) {
        case "build":
            endpointUrl = BUILD_ENDPOINT_URL;
            break;
        case "ncp":
            ncpPartner = opts.ncpPartner ?? (await (0, prompt_js_1.promptInput)("NCP partner name"));
            endpointUrl =
                opts.endpointUrl ??
                    (await (0, prompt_js_1.promptInput)("NCP endpoint URL (e.g., https://partner.api.nvidia.com/v1)"));
            break;
        case "nim-local":
            endpointUrl =
                opts.endpointUrl ??
                    (await (0, prompt_js_1.promptInput)("NIM endpoint URL", "http://nim-service.local:8000/v1"));
            break;
        case "vllm":
            endpointUrl = `${HOST_GATEWAY_URL}:8000/v1`;
            break;
        case "ollama":
            endpointUrl = opts.endpointUrl ?? `${HOST_GATEWAY_URL}:11434/v1`;
            break;
        case "baseten":
            endpointUrl = "https://inference.baseten.co/v1";
            break;
        case "custom":
            endpointUrl = opts.endpointUrl ?? (await (0, prompt_js_1.promptInput)("Custom endpoint URL"));
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
        }
        else {
            const envKeyName = resolveCredentialEnv(endpointType);
            const envKey = process.env[envKeyName];
            const keySource = endpointType === "baseten" ? "https://app.baseten.co" : "https://build.nvidia.com/settings/api-keys";
            if (envKey) {
                logger.info(`Detected ${envKeyName} in environment (${(0, validate_js_1.maskApiKey)(envKey)})`);
                const useEnv = nonInteractive ? true : await (0, prompt_js_1.promptConfirm)("Use this key?");
                apiKey = useEnv ? envKey : await (0, prompt_js_1.promptInput)(`Enter your ${envKeyName}`);
            }
            else {
                logger.info(`Get an API key from: ${keySource}`);
                apiKey = await (0, prompt_js_1.promptInput)(`Enter your ${envKeyName}`);
            }
        }
    }
    else {
        logger.info(`No API key required for ${endpointType}. Using local credential value '${apiKey}'.`);
    }
    if (!apiKey) {
        logger.error("No API key provided. Aborting.");
        return;
    }
    // Step 4: Validate API Key
    // For local endpoints (vllm, ollama, nim-local), validation is best-effort since the
    // service may not be running yet during onboarding.
    const isLocalEndpoint = endpointType === "vllm" || endpointType === "ollama" || endpointType === "nim-local";
    logger.info("");
    logger.info(`Validating ${requiresApiKey ? "credential" : "endpoint"} against ${endpointUrl}...`);
    const validation = await (0, validate_js_1.validateApiKey)(apiKey, endpointUrl);
    if (!validation.valid) {
        if (isLocalEndpoint) {
            logger.warn(`Could not reach ${endpointUrl} (${validation.error ?? "unknown error"}). Continuing anyway — the service may not be running yet.`);
        }
        else {
            logger.error(`API key validation failed: ${validation.error ?? "unknown error"}`);
            logger.info("Check your key at https://build.nvidia.com/settings/api-keys");
            return;
        }
    }
    else {
        logger.info(`${requiresApiKey ? "Credential" : "Endpoint"} valid. ${String(validation.models.length)} model(s) available.`);
    }
    // Step 5: Model Selection
    let model;
    if (opts.model) {
        model = opts.model;
    }
    else {
        // Build model options: for Baseten show all discovered models or GLM-5 fallback;
        // for other providers prefer Nemotron models, falling back to DEFAULT_MODELS.
        const preferredModels = endpointType === "baseten"
            ? validation.models
            : validation.models.filter((m) => m.includes("nemotron"));
        const fallbackModels = endpointType === "baseten"
            ? BASETEN_MODELS.map((m) => ({ label: `${m.label} (${m.id})`, value: m.id }))
            : DEFAULT_MODELS.map((m) => ({ label: `${m.label} (${m.id})`, value: m.id }));
        const modelOptions = preferredModels.length > 0
            ? preferredModels.map((id) => ({ label: id, value: id }))
            : fallbackModels;
        model = await (0, prompt_js_1.promptSelect)("Select your primary model:", modelOptions);
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
    logger.info(`  API Key:     ${requiresApiKey ? (0, validate_js_1.maskApiKey)(apiKey) : "not required (local provider)"}`);
    logger.info(`  Credential:  $${credentialEnv}`);
    logger.info(`  Profile:     ${profile}`);
    logger.info(`  Provider:    ${providerName}`);
    logger.info("");
    if (!nonInteractive) {
        const proceed = await (0, prompt_js_1.promptConfirm)("Apply this configuration?");
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
    }
    catch (err) {
        const stderr = err instanceof Error && "stderr" in err ? String(err.stderr) : "";
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
            }
            catch (updateErr) {
                const updateStderr = updateErr instanceof Error && "stderr" in updateErr
                    ? String(updateErr.stderr)
                    : "";
                logger.error(`Failed to update provider: ${updateStderr || String(updateErr)}`);
                return;
            }
        }
        else {
            logger.error(`Failed to create provider: ${stderr || String(err)}`);
            return;
        }
    }
    // 7b: Set inference route
    try {
        execOpenShell(["inference", "set", "--provider", providerName, "--model", model]);
        logger.info(`Inference route set: ${providerName} -> ${model}`);
    }
    catch (err) {
        const stderr = err instanceof Error && "stderr" in err ? String(err.stderr) : "";
        logger.error(`Failed to set inference route: ${stderr || String(err)}`);
        return;
    }
    // 7c: Save config
    (0, config_js_1.saveOnboardConfig)({
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
//# sourceMappingURL=onboard.js.map