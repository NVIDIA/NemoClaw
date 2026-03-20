"use strict";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
Object.defineProperty(exports, "__esModule", { value: true });
exports.cliStatus = cliStatus;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_util_1 = require("node:util");
const state_js_1 = require("../blueprint/state.js");
const execAsync = (0, node_util_1.promisify)(node_child_process_1.exec);
/**
 * Detect whether the plugin is running inside an OpenShell sandbox.
 * Inside sandboxes the root filesystem is mounted at /sandbox and openshell
 * host commands are not available, so querying `openshell sandbox status`
 * would always fail — producing false-negative "not running" reports.
 */
function isInsideSandbox() {
    return (0, node_fs_1.existsSync)("/sandbox/.openclaw") || (0, node_fs_1.existsSync)("/sandbox/.nemoclaw");
}
async function cliStatus(opts) {
    const { json: jsonOutput, logger } = opts;
    const state = (0, state_js_1.loadState)();
    const sandboxName = state.sandboxName ?? "openclaw";
    const insideSandbox = isInsideSandbox();
    const [sandbox, inference] = await Promise.all([
        getSandboxStatus(sandboxName, insideSandbox),
        getInferenceStatus(insideSandbox),
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
        insideSandbox,
    };
    if (jsonOutput) {
        logger.info(JSON.stringify(statusData, null, 2));
        return;
    }
    logger.info("NemoClaw Status");
    logger.info("===============");
    logger.info("");
    if (insideSandbox) {
        logger.info("Context: running inside an active OpenShell sandbox");
        logger.info("  Host sandbox state is not inspectable from inside the sandbox.");
        logger.info("  Run 'openshell sandbox status' on the host for full details.");
        logger.info("");
    }
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
    else if (sandbox.insideSandbox) {
        logger.info(`  Name:    ${sandbox.name}`);
        logger.info("  Status:  active (inside sandbox)");
        logger.info("  Note:    Cannot query host sandbox state from within the sandbox.");
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
    else if (inference.insideSandbox) {
        logger.info("  Status:  unable to query from inside sandbox");
        logger.info("  Note:    Run 'openshell inference get' on the host to check.");
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
async function getSandboxStatus(sandboxName, insideSandbox) {
    if (insideSandbox) {
        return { name: sandboxName, running: false, uptime: null, insideSandbox: true };
    }
    try {
        const { stdout } = await execAsync(`openshell sandbox status ${sandboxName} --json`, {
            timeout: 5000,
        });
        const parsed = JSON.parse(stdout);
        return {
            name: sandboxName,
            running: parsed.state === "running",
            uptime: parsed.uptime ?? null,
            insideSandbox: false,
        };
    }
    catch {
        return { name: sandboxName, running: false, uptime: null, insideSandbox: false };
    }
}
async function getInferenceStatus(insideSandbox) {
    if (insideSandbox) {
        return { configured: false, provider: null, model: null, endpoint: null, insideSandbox: true };
    }
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
            insideSandbox: false,
        };
    }
    catch {
        return { configured: false, provider: null, model: null, endpoint: null, insideSandbox: false };
    }
}
//# sourceMappingURL=status.js.map