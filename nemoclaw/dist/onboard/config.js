"use strict";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadOnboardConfig = loadOnboardConfig;
exports.saveOnboardConfig = saveOnboardConfig;
exports.clearOnboardConfig = clearOnboardConfig;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const CONFIG_DIR = (0, node_path_1.join)(process.env.HOME ?? "/tmp", ".nemoclaw");
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
    (0, node_fs_1.writeFileSync)(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}
function clearOnboardConfig() {
    const path = configPath();
    if ((0, node_fs_1.existsSync)(path)) {
        (0, node_fs_1.unlinkSync)(path);
    }
}
//# sourceMappingURL=config.js.map