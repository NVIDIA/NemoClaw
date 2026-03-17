"use strict";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPluginConfig = getPluginConfig;
exports.default = register;
/**
 * NemoClaw — OpenClaw Plugin for OpenShell
 *
 * Uses the real OpenClaw plugin API. Types defined locally are minimal stubs
 * that match the OpenClaw SDK interfaces available at runtime via
 * `openclaw/plugin-sdk`. We define them here because the SDK package is only
 * available inside the OpenClaw host process and cannot be imported at build
 * time.
 */
const node_child_process_1 = require("node:child_process");
const cli_js_1 = require("./cli.js");
const slash_js_1 = require("./commands/slash.js");
const config_js_1 = require("./onboard/config.js");
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
    const providerLabel = onboardCfg
        ? `NVIDIA NIM (${onboardCfg.endpointType}${onboardCfg.ncpPartner ? ` - ${onboardCfg.ncpPartner}` : ""})`
        : "NVIDIA NIM (build.nvidia.com)";
    api.registerProvider({
        id: "nvidia-nim",
        label: providerLabel,
        docsPath: "https://build.nvidia.com/docs",
        aliases: ["nvidia", "nim"],
        envVars: [providerCredentialEnv],
        models: {
            chat: [
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
            ],
        },
        auth: [
            {
                type: "bearer",
                envVar: providerCredentialEnv,
                headerName: "Authorization",
                label: `NVIDIA API Key (${providerCredentialEnv})`,
            },
        ],
    });
    // Resolve banner values: prefer onboard config, fall back to live
    // OpenShell inference state, then to hardcoded defaults.
    let bannerEndpoint = onboardCfg?.endpointType ?? "";
    let bannerModel = onboardCfg?.model ?? "";
    if (!bannerEndpoint || !bannerModel) {
        try {
            const raw = (0, node_child_process_1.execFileSync)("openshell", ["inference", "get", "--json"], {
                encoding: "utf-8",
                timeout: 3000,
                stdio: ["pipe", "pipe", "pipe"],
            });
            const parsed = JSON.parse(raw);
            if (!bannerEndpoint)
                bannerEndpoint = parsed.endpoint ?? parsed.provider ?? "";
            if (!bannerModel)
                bannerModel = parsed.model ?? "";
        }
        catch {
            // openshell not available or not configured — use defaults
        }
    }
    if (!bannerEndpoint)
        bannerEndpoint = "build.nvidia.com";
    if (!bannerModel)
        bannerModel = "nvidia/nemotron-3-super-120b-a12b";
    api.logger.info("");
    api.logger.info("  ┌─────────────────────────────────────────────────────┐");
    api.logger.info("  │  NemoClaw registered                                │");
    api.logger.info("  │                                                     │");
    api.logger.info(`  │  Endpoint:  ${bannerEndpoint.padEnd(40)}│`);
    api.logger.info(`  │  Model:     ${bannerModel.padEnd(40)}│`);
    api.logger.info("  │  Commands:  openclaw nemoclaw <command>             │");
    api.logger.info("  └─────────────────────────────────────────────────────┘");
    api.logger.info("");
}
//# sourceMappingURL=index.js.map