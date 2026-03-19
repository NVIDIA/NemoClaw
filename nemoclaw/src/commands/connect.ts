// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import type { PluginLogger } from "../index.js";
import { ensureOpenShellCli } from "./openshell-cli.js";

export interface ConnectOptions {
  sandbox: string;
  logger: PluginLogger;
}

export async function cliConnect(opts: ConnectOptions): Promise<void> {
  const { sandbox: sandboxName, logger } = opts;

  logger.info(`Connecting to OpenClaw sandbox: ${sandboxName}`);
  logger.info("You will be inside the sandbox. Run 'openclaw' commands normally.");
  logger.info("Type 'exit' to return to your host shell.");
  logger.info("");

  if (!ensureOpenShellCli(logger, "nemoclaw <name> connect")) {
    return;
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    const proc = spawn("openshell", ["sandbox", "connect", sandboxName], {
      stdio: "inherit",
    });
    proc.on("close", resolve);
    proc.on("error", (err) => {
      if (err.message.includes("ENOENT")) {
        logger.error("openshell CLI not found. Is OpenShell installed?");
      } else {
        logger.error(`Connection failed: ${err.message}`);
      }
      resolve(1);
    });
  });

  if (exitCode !== 0 && exitCode !== null) {
    logger.error(`Sandbox '${sandboxName}' exited with code ${String(exitCode)}.`);
    logger.info("Run 'openclaw nemoclaw status' to check available sandboxes.");
  }
}
