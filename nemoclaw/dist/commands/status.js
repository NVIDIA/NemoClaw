"use strict";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
Object.defineProperty(exports, "__esModule", { value: true });
exports.cliStatus = cliStatus;
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const state_js_1 = require("../blueprint/state.js");
const openshell_cli_js_1 = require("./openshell-cli.js");
const execAsync = (0, node_util_1.promisify)(node_child_process_1.exec);
async function cliStatus(opts) {
    const { json: jsonOutput, logger } = opts;
    if (!(0, openshell_cli_js_1.ensureOpenShellCli)(logger, "nemoclaw <name> status")) {
        return;
    }
    const state = (0, state_js_1.loadState)();
    const sandboxName = state.sandboxName ?? "openclaw";
    const [sandbox, inference] = await Promise.all([
        getSandboxStatus(sandboxName),
        getInferenceStatus(),
    ]);
    const statusData = {
        nemoclaw: {
            lastAction: state.lastAction,
            lastRunId: state.lastRunId,
            blueprintVersion: state.blueprintVersion,
            sandboxName: state.sandboxName,
            migrationSnapshot: state.migrationSnapshot,
            updatedAt: state.updatedAt,
        },
        sandbox,
        inference,
    };
    if (jsonOutput) {
        logger.info(JSON.stringify(statusData, null, 2));
        return;
    }
    logger.info("NemoClaw Status");
    logger.info("===============");
    logger.info("");
    logger.info("Plugin State:");
    if (state.lastAction) {
        logger.info(`  Last action:      ${state.lastAction}`);
        logger.info(`  Blueprint:        ${state.blueprintVersion ?? "unknown"}`);
        logger.info(`  Run ID:           ${state.lastRunId ?? "none"}`);
        logger.info(`  Updated:          ${state.updatedAt}`);
    }
    else {
        logger.info("  No operations have been performed yet.");
    }
    logger.info("");
    logger.info("Sandbox:");
    if (sandbox.running) {
        logger.info(`  Name:    ${sandbox.name}`);
        logger.info("  Status:  running");
        logger.info(`  Uptime:  ${sandbox.uptime ?? "unknown"}`);
    }
    else {
        logger.info("  Status:  not running");
    }
    logger.info("");
    logger.info("Inference:");
    if (inference.configured) {
        logger.info(`  Provider:  ${inference.provider ?? "unknown"}`);
        logger.info(`  Model:     ${inference.model ?? "unknown"}`);
        logger.info(`  Endpoint:  ${inference.endpoint ?? "unknown"}`);
    }
    else {
        logger.info("  Not configured");
    }
    if (state.migrationSnapshot) {
        logger.info("");
        logger.info("Rollback:");
        logger.info(`  Snapshot:  ${state.migrationSnapshot}`);
        logger.info("  Run 'openclaw nemoclaw eject' to restore host installation.");
    }
}
async function getSandboxStatus(sandboxName) {
    try {
        const { stdout } = await execAsync(`openshell sandbox status ${sandboxName} --json`, {
            timeout: 5000,
        });
        const parsed = JSON.parse(stdout);
        return {
            name: sandboxName,
            running: parsed.state === "running",
            uptime: parsed.uptime ?? null,
        };
    }
    catch {
        return { name: sandboxName, running: false, uptime: null };
    }
}
async function getInferenceStatus() {
    try {
        const { stdout } = await execAsync("openshell inference get --json", {
            timeout: 5000,
        });
        const parsed = JSON.parse(stdout);
        return {
            configured: true,
            provider: parsed.provider ?? null,
            model: parsed.model ?? null,
            endpoint: parsed.endpoint ?? null,
        };
    }
    catch {
        return { configured: false, provider: null, model: null, endpoint: null };
    }
}
//# sourceMappingURL=status.js.map