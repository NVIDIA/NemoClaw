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
                logger.error("OpenShell CLI not found. Is OpenShell installed?\n" +
                    "  Install guide: https://docs.nvidia.com/nemoclaw/openshell/install");
            }
            else {
                logger.error(`OpenShell error running 'openshell sandbox connect': ${err.message}\n` +
                    "  Troubleshooting: https://docs.nvidia.com/nemoclaw/openshell/troubleshooting");
            }
            resolve(1);
        });
    });
    if (exitCode !== 0 && exitCode !== null) {
        logger.error(`Sandbox '${sandboxName}' exited with code ${String(exitCode)}.`);
        logger.info("Run 'openclaw nemoclaw status' to check available sandboxes.");
    }
}
//# sourceMappingURL=connect.js.map