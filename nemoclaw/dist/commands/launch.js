"use strict";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
Object.defineProperty(exports, "__esModule", { value: true });
exports.cliLaunch = cliLaunch;
const node_child_process_1 = require("node:child_process");
const resolve_js_1 = require("../blueprint/resolve.js");
const verify_js_1 = require("../blueprint/verify.js");
const exec_js_1 = require("../blueprint/exec.js");
const state_js_1 = require("../blueprint/state.js");
const migrate_js_1 = require("./migrate.js");
async function cliLaunch(opts) {
    const { force, profile, logger, pluginConfig } = opts;
    logger.info("NemoClaw launch: setting up OpenClaw inside OpenShell");
    // Check if there's an existing host OpenClaw installation
    const hostState = (0, migrate_js_1.detectHostOpenClaw)();
    if (!hostState.exists && !force) {
        logger.info("");
        logger.info("No existing OpenClaw installation detected on this host.");
        logger.info("");
        logger.info("For net-new users, the recommended path is OpenShell-native setup:");
        logger.info("");
        logger.info("  openshell sandbox create --from openclaw --name openclaw");
        logger.info("  openshell sandbox connect openclaw");
        logger.info("");
        logger.info("This avoids installing OpenClaw on the host only to redeploy it inside OpenShell.");
        logger.info("");
        logger.info("To proceed with NemoClaw-driven bootstrap anyway, use --force.");
        return;
    }
    if (hostState.exists && !force) {
        logger.info("Existing OpenClaw installation detected. Consider using 'openclaw nemoclaw migrate' instead.");
        logger.info("Use --force to proceed with a fresh launch (existing config will not be migrated).");
        return;
    }
    // Resolve and verify blueprint
    logger.info("Resolving blueprint...");
    const blueprint = await (0, resolve_js_1.resolveBlueprint)(pluginConfig);
    logger.info("Verifying blueprint integrity...");
    const verification = (0, verify_js_1.verifyBlueprintDigest)(blueprint.localPath, blueprint.manifest);
    if (!verification.valid) {
        logger.error(`Blueprint verification failed: ${verification.errors.join(", ")}`);
        logger.error("This may indicate a corrupted or outdated OpenShell deployment.");
        logger.error("Docs: https://github.com/NVIDIA/OpenShell");
        return;
    }
    // Check version compatibility
    const openshellVersion = getOpenshellVersion();
    const openclawVersion = getOpenclawVersion();
    const compat = (0, verify_js_1.checkCompatibility)(blueprint.manifest, openshellVersion, openclawVersion);
    if (compat.length > 0) {
        logger.error(`Compatibility check failed:\n  ${compat.join("\n  ")}`);
        logger.error("Check OpenShell version: openshell --version");
        logger.error("Upgrade: https://github.com/NVIDIA/OpenShell/releases");
        return;
    }
    // Plan
    logger.info("Planning deployment...");
    const planResult = await (0, exec_js_1.execBlueprint)({
        blueprintPath: blueprint.localPath,
        action: "plan",
        profile,
        jsonOutput: true,
    }, logger);
    if (!planResult.success) {
        logger.error(`Blueprint plan failed: ${planResult.output}`);
        return;
    }
    // Apply
    logger.info("Deploying OpenClaw sandbox...");
    const applyResult = await (0, exec_js_1.execBlueprint)({
        blueprintPath: blueprint.localPath,
        action: "apply",
        profile,
        planPath: planResult.runId,
        jsonOutput: true,
    }, logger);
    if (!applyResult.success) {
        logger.error(`Blueprint apply failed: ${applyResult.output}`);
        logger.error("Debug: openshell sandbox list && openshell gateway info");
        return;
    }
    // Save state
    (0, state_js_1.saveState)({
        ...(0, state_js_1.loadState)(),
        lastRunId: applyResult.runId,
        lastAction: "launch",
        blueprintVersion: blueprint.version,
        sandboxName: pluginConfig.sandboxName,
    });
    logger.info("");
    logger.info("OpenClaw is now running inside OpenShell.");
    logger.info(`Sandbox: ${pluginConfig.sandboxName}`);
    logger.info("");
    logger.info("Next steps:");
    logger.info("  openclaw nemoclaw connect    # Enter the sandbox");
    logger.info("  openclaw nemoclaw status     # Check health");
    logger.info("  openshell term               # Monitor network egress");
}
function getOpenshellVersion() {
    try {
        return (0, node_child_process_1.execSync)("openshell --version", { encoding: "utf-8" }).trim();
    }
    catch {
        return "0.0.0";
    }
}
function getOpenclawVersion() {
    try {
        return (0, node_child_process_1.execSync)("openclaw --version", { encoding: "utf-8" }).trim();
    }
    catch {
        return "0.0.0";
    }
}
//# sourceMappingURL=launch.js.map