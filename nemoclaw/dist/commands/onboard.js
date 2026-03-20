"use strict";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
Object.defineProperty(exports, "__esModule", { value: true });
exports.cliOnboard = cliOnboard;
const node_child_process_1 = require("node:child_process");
const config_js_1 = require("../onboard/config.js");
const prompt_js_1 = require("../onboard/prompt.js");
const validate_js_1 = require("../onboard/validate.js");
const ENDPOINT_TYPES = ["build", "ncp", "nim-local", "vllm", "ollama", "custom"];
const SUPPORTED_ENDPOINT_TYPES = ["build", "ncp", "ollama"];
function isExperimentalEnabled() {
    return process.env.NEMOCLAW_EXPERIMENTAL === "1";
}
const BUILD_ENDPOINT_URL = "https://integrate.api.nvidia.com/v1";
const HOST_GATEWAY_URL = "http://host.openshell.internal";
const DEFAULT_MODELS = [
    { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B" },
    { id: "moonshotai/kimi-k2.5", label: "Kimi K2.5" },
    { id: "z-ai/glm5", label: "GLM-5" },
    { id: "minimaxai/minimax-m2.5", label: "MiniMax M2.5" },
    { id: "qwen/qwen3.5-397b-a17b", label: "Qwen3.5 397B A17B" },
    { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
];
const DEFAULT_OLLAMA_MODEL = "nemotron-3-nano:30b";
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
    }
}
function isNonInteractive(opts) {
    if (!opts.endpoint || !opts.model)
        return false;
    const ep = opts.endpoint;
    if (endpointRequiresApiKey(ep) && !opts.apiKey)
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
function parseOllamaList(output) {
    return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^NAME\s+/i.test(line))
        .map((line) => line.split(/\s{2,}/)[0])
        .filter(Boolean);
}
function getOllamaModelOptions() {
    try {
        const output = (0, node_child_process_1.execSync)("ollama list", { encoding: "utf-8", shell: "/bin/bash" });
        const parsed = parseOllamaList(output);
        if (parsed.length > 0) {
            return parsed;
        }
    }
    catch { }
    return [DEFAULT_OLLAMA_MODEL];
}
function getDefaultOllamaModel() {
    const models = getOllamaModelOptions();
    return models.includes(DEFAULT_OLLAMA_MODEL) ? DEFAULT_OLLAMA_MODEL : models[0];
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
    logger.info(`  Endpoint:    ${(0, config_js_1.describeOnboardEndpoint)(config)}`);
    logger.info(`  Provider:    ${(0, config_js_1.describeOnboardProvider)(config)}`);
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
    ];
    options.push({
        label: "Local Ollama",
        value: "ollama",
        hint: ollama.running
            ? "detected on localhost:11434"
            : ollama.installed
                ? "installed locally"
                : "localhost:11434",
    });
    if (isExperimentalEnabled()) {
        options.push({
            label: "Self-hosted NIM [experimental]",
            value: "nim-local",
            hint: "experimental — your own NIM container deployment",
        }, {
            label: "Local vLLM [experimental]",
            value: "vllm",
            hint: "experimental — local development",
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
        if (ollama.running) {
            logger.info("Detected local inference option: Ollama.");
            logger.info("Select it explicitly if you want to use it.");
        }
        endpointType = await promptEndpoint(ollama);
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
            const envKey = process.env.NVIDIA_API_KEY;
            if (envKey) {
                logger.info(`Detected NVIDIA_API_KEY in environment (${(0, validate_js_1.maskApiKey)(envKey)})`);
                const useEnv = nonInteractive ? true : await (0, prompt_js_1.promptConfirm)("Use this key?");
                apiKey = useEnv ? envKey : await (0, prompt_js_1.promptInput)("Enter your NVIDIA API key");
            }
            else {
                logger.info("Get an API key from: https://build.nvidia.com/settings/api-keys");
                apiKey = await (0, prompt_js_1.promptInput)("Enter your NVIDIA API key");
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
        const discoveredModelOptions = endpointType === "ollama"
            ? getOllamaModelOptions().map((id) => ({ label: id, value: id }))
            : validation.models.map((id) => ({ label: id, value: id }));
        const curatedCloudOptions = endpointType === "build" || endpointType === "ncp"
            ? DEFAULT_MODELS.filter((option) => validation.models.includes(option.id)).map((option) => ({
                label: `${option.label} (${option.id})`,
                value: option.id,
            }))
            : [];
        const defaultIndex = endpointType === "ollama"
            ? Math.max(0, discoveredModelOptions.findIndex((option) => option.value === getDefaultOllamaModel()))
            : 0;
        const modelOptions = curatedCloudOptions.length > 0
            ? curatedCloudOptions
            : discoveredModelOptions.length > 0
                ? discoveredModelOptions
                : DEFAULT_MODELS.map((m) => ({ label: `${m.label} (${m.id})`, value: m.id }));
        model = await (0, prompt_js_1.promptSelect)("Select your primary model:", modelOptions, defaultIndex);
    }
    // Step 6: Resolve profile
    const profile = resolveProfile(endpointType);
    const providerName = resolveProviderName(endpointType);
    const summaryConfig = {
        endpointType,
        endpointUrl,
        ncpPartner,
        model,
        profile,
        credentialEnv,
        provider: providerName,
        providerLabel: undefined,
        onboardedAt: "",
    };
    summaryConfig.providerLabel = (0, config_js_1.describeOnboardProvider)(summaryConfig);
    // Step 7: Confirmation
    logger.info("");
    logger.info("Configuration summary:");
    logger.info(`  Endpoint:    ${(0, config_js_1.describeOnboardEndpoint)(summaryConfig)}`);
    logger.info(`  Provider:    ${summaryConfig.providerLabel}`);
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
        provider: providerName,
        providerLabel: summaryConfig.providerLabel,
        onboardedAt: new Date().toISOString(),
    });
    // Step 9: Success
    logger.info("");
    logger.info("Onboarding complete!");
    logger.info("");
    logger.info(`  Endpoint:   ${(0, config_js_1.describeOnboardEndpoint)(summaryConfig)}`);
    logger.info(`  Provider:   ${summaryConfig.providerLabel}`);
    logger.info(`  Model:      ${model}`);
    logger.info(`  Credential: $${credentialEnv}`);
    logger.info("");
    logger.info("Next steps:");
    logger.info("  openclaw nemoclaw launch     # Bootstrap sandbox");
    logger.info("  openclaw nemoclaw status     # Check configuration");
}
//# sourceMappingURL=onboard.js.map