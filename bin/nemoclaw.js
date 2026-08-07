#!/usr/bin/env node
// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const invokedAs = require("node:path").basename(process.argv[1] || "");
if (invokedAs === "nemo-deepagents") {
  process.env.NEMOCLAW_AGENT = "langchain-deepagents-code";
  process.env.NEMOCLAW_INVOKED_AS = "nemo-deepagents";
}

function handleTopLevelError(error) {
  let message = "Command failed.";
  try {
    message = String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, " ");
  } catch {
    // Keep the top-level rejection handler reliable even for values with throwing coercion hooks.
  }
  try {
    const { log } = require("../dist/lib/cli/logger");
    log.error(`Error: ${message}`);
  } catch {
    try {
      process.stderr.write(`Error: ${message}\n`);
    } catch {
      // Do not let a broken diagnostic sink throw another top-level error.
    }
  }
  process.exitCode = 1;
}

try {
  const { mainPromise } = require("../dist/nemoclaw");
  mainPromise.catch(handleTopLevelError);
} catch (error) {
  handleTopLevelError(error);
}
