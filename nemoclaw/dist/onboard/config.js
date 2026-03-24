"use strict";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
Object.defineProperty(exports, "__esModule", { value: true });
exports.describeOnboardEndpoint = describeOnboardEndpoint;
exports.describeOnboardProvider = describeOnboardProvider;
exports.loadOnboardConfig = loadOnboardConfig;
exports.saveOnboardConfig = saveOnboardConfig;
exports.clearOnboardConfig = clearOnboardConfig;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const CONFIG_DIR = (0, node_path_1.join)(process.env.HOME ?? "/tmp", ".nemoclaw");
function describeOnboardEndpoint(config) {
    if (config.endpointUrl === "https://inference.local/v1") {
        return "Managed Inference Route (inference.local)";
    }
    return `${config.endpointType} (${config.endpointUrl})`;
}
function describeOnboardProvider(config) {
    if (config.providerLabel) {
        return config.providerLabel;
    }
    switch (config.endpointType) {
        case "build":
            return "NVIDIA Cloud API";
        case "ollama":
            return "Local Ollama";
        case "vllm":
            return "Local vLLM";
        case "nim-local":
            return "Local NIM";
        case "ncp":
            return "NVIDIA Cloud Partner";
        case "custom":
            return "Managed Inference Route";
        default:
            return "Unknown";
    }
}
let configDirCreated = false;
function ensureConfigDir() {
    if (configDirCreated)
        return;
    if (!(0, node_fs_1.existsSync)(CONFIG_DIR)) {
        (0, node_fs_1.mkdirSync)(CONFIG_DIR, { recursive: true });
    }
    configDirCreated = true;
}
function configPath() {
    return (0, node_path_1.join)(CONFIG_DIR, "config.json");
}
function loadOnboardConfig() {
    ensureConfigDir();
    const path = configPath();
    if (!(0, node_fs_1.existsSync)(path)) {
        return null;
    }
    return JSON.parse((0, node_fs_1.readFileSync)(path, "utf-8"));
}
function saveOnboardConfig(config) {
    ensureConfigDir();
    (0, node_fs_1.writeFileSync)(configPath(), JSON.stringify(config, null, 2));
}
function clearOnboardConfig() {
    const path = configPath();
    if ((0, node_fs_1.existsSync)(path)) {
        (0, node_fs_1.unlinkSync)(path);
    }
}
//# sourceMappingURL=config.js.map