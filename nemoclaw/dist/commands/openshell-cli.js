"use strict";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureOpenShellCli = ensureOpenShellCli;
const node_child_process_1 = require("node:child_process");
function ensureOpenShellCli(logger, commandName) {
    const probe = (0, node_child_process_1.spawnSync)("openshell", ["--version"], {
        stdio: "ignore",
    });
    if (!probe.error && probe.status === 0) {
        return true;
    }
    logger.error(`OpenShell CLI (\`openshell\`) is required for \`${commandName}\` but was not found on PATH.`);
    logger.info("Install OpenShell and ensure the `openshell` command is available before retrying.");
    logger.info("See the NemoClaw prerequisites/installation docs for the supported setup path.");
    return false;
}
//# sourceMappingURL=openshell-cli.js.map