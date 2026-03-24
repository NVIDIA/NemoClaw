"use strict";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPluginConfig = getPluginConfig;
exports.default = register;
const cli_js_1 = require("./cli.js");
const slash_js_1 = require("./commands/slash.js");
const config_js_1 = require("./onboard/config.js");
function activeModelEntries(onboardCfg) {
    if (!onboardCfg?.model) {
        return [
            {
                id: "nvidia/nemotron-3-super-120b-a12b",
                label: "Nemotron 3 Super 120B (March 2026)",
                contextWindow: 131072,
                maxOutput: 8192,
            },
            {
                id: "nvidia/llama-3.1-nemotron-ultra-253b-v1",
                label: "Nemotron Ultra 253B",
                contextWindow: 131072,
                maxOutput: 4096,
            },
            {
                id: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
                label: "Nemotron Super 49B v1.5",
                contextWindow: 131072,
                maxOutput: 4096,
            },
            {
                id: "nvidia/nemotron-3-nano-30b-a3b",
                label: "Nemotron 3 Nano 30B",
                contextWindow: 131072,
                maxOutput: 4096,
            },
        ];
    }
    return [
        {
            id: `inference/${onboardCfg.model}`,
            label: onboardCfg.model,
            contextWindow: 131072,
            maxOutput: 8192,
        },
    ];
}
function registeredProviderForConfig(onboardCfg, providerCredentialEnv) {
    const authLabel = providerCredentialEnv === "NVIDIA_API_KEY"
        ? `NVIDIA API Key (${providerCredentialEnv})`
        : `OpenAI API Key (${providerCredentialEnv})`;
    return {
        id: "inference",
        label: "Managed Inference Route",
        aliases: ["inference-local", "nemoclaw"],
        envVars: [providerCredentialEnv],
        models: { chat: activeModelEntries(onboardCfg) },
        auth: [{ type: "bearer", envVar: providerCredentialEnv, headerName: "Authorization", label: authLabel }],
    };
}
const DEFAULT_PLUGIN_CONFIG = {
    blueprintVersion: "latest",
    blueprintRegistry: "ghcr.io/nvidia/nemoclaw-blueprint",
    sandboxName: "openclaw",
    inferenceProvider: "nvidia",
};
function getPluginConfig(api) {
    const raw = api.pluginConfig ?? {};
    return {
        blueprintVersion: typeof raw["blueprintVersion"] === "string"
            ? raw["blueprintVersion"]
            : DEFAULT_PLUGIN_CONFIG.blueprintVersion,
        blueprintRegistry: typeof raw["blueprintRegistry"] === "string"
            ? raw["blueprintRegistry"]
            : DEFAULT_PLUGIN_CONFIG.blueprintRegistry,
        sandboxName: typeof raw["sandboxName"] === "string"
            ? raw["sandboxName"]
            : DEFAULT_PLUGIN_CONFIG.sandboxName,
        inferenceProvider: typeof raw["inferenceProvider"] === "string"
            ? raw["inferenceProvider"]
            : DEFAULT_PLUGIN_CONFIG.inferenceProvider,
    };
}
// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------
function register(api) {
    // 1. Register /nemoclaw slash command (chat interface)
    api.registerCommand({
        name: "nemoclaw",
        description: "NemoClaw sandbox management (status, eject).",
        acceptsArgs: true,
        handler: (ctx) => (0, slash_js_1.handleSlashCommand)(ctx, api),
    });
    // 2. Register `openclaw nemoclaw` CLI subcommands (commander.js)
    api.registerCli((cliCtx) => {
        (0, cli_js_1.registerCliCommands)(cliCtx, api);
    }, { commands: ["nemoclaw"] });
    // 3. Register nvidia-nim provider — use onboard config if available
    const onboardCfg = (0, config_js_1.loadOnboardConfig)();
    const providerCredentialEnv = onboardCfg?.credentialEnv ?? "NVIDIA_API_KEY";
    api.registerProvider(registeredProviderForConfig(onboardCfg, providerCredentialEnv));
    const bannerEndpoint = onboardCfg ? (0, config_js_1.describeOnboardEndpoint)(onboardCfg) : "build.nvidia.com";
    const bannerProvider = onboardCfg ? (0, config_js_1.describeOnboardProvider)(onboardCfg) : "NVIDIA Cloud API";
    const bannerModel = onboardCfg?.model ?? "nvidia/nemotron-3-super-120b-a12b";
    api.logger.info("");
    api.logger.info("  ┌─────────────────────────────────────────────────────┐");
    api.logger.info("  │  NemoClaw registered                                │");
    api.logger.info("  │                                                     │");
    api.logger.info(`  │  Endpoint:  ${bannerEndpoint.padEnd(40)}│`);
    api.logger.info(`  │  Provider:  ${bannerProvider.padEnd(40)}│`);
    api.logger.info(`  │  Model:     ${bannerModel.padEnd(40)}│`);
    api.logger.info("  │  Commands:  openclaw nemoclaw <command>             │");
    api.logger.info("  └─────────────────────────────────────────────────────┘");
    api.logger.info("");
}
//# sourceMappingURL=index.js.map