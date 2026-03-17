"use strict";
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
Object.defineProperty(exports, "__esModule", { value: true });
exports.cliConnect = cliConnect;
const node_child_process_1 = require("node:child_process");
async function cliConnect(opts) {
    const { sandbox: sandboxName, logger } = opts;
    logger.info(`Connecting to OpenClaw sandbox: ${sandboxName}`);
    logger.info("You will be inside the sandbox. Run 'openclaw' commands normally.");
    logger.info("Type 'exit' to return to your host shell.");
    logger.info("");
    const exitCode = await new Promise((resolve) => {
        const proc = (0, node_child_process_1.spawn)("openshell", ["sandbox", "connect", sandboxName], {
            stdio: "inherit",
        });
        proc.on("close", resolve);
        proc.on("error", (err) => {
            if (err.message.includes("ENOENT")) {
                logger.error("openshell CLI not found. Is OpenShell installed?");
                logger.error("Install: https://github.com/NVIDIA/OpenShell/releases");
            }
            else {
                logger.error(`Connection failed (OpenShell): ${err.message}`);
                logger.error("Docs: https://github.com/NVIDIA/OpenShell");
            }
            resolve(1);
        });
    });
    if (exitCode !== 0 && exitCode !== null) {
        logger.error(`Sandbox '${sandboxName}' exited with code ${String(exitCode)}.`);
        logger.info("Run 'openclaw nemoclaw status' to check available sandboxes.");
        logger.info("Debug: openshell sandbox list");
    }
}
//# sourceMappingURL=connect.js.map