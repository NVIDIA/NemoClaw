#!/usr/bin/env node
// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const invokedAs = require("node:path").basename(process.argv[1] || "");
if (invokedAs === "nemo-deepagents") {
  process.env.NEMOCLAW_AGENT = "langchain-deepagents-code";
  process.env.NEMOCLAW_INVOKED_AS = "nemo-deepagents";
}

const { log } = require("../dist/lib/cli/logger");

function reportTopLevelCliError(error) {
  let message = "Command failed without an error message.";
  try {
    const candidate = error instanceof Error ? error.message : String(error);
    if (candidate.trim()) message = candidate.trim();
  } catch {
    // Keep the fallback message when an unusual thrown value cannot be stringified.
  }
  log.error(`Error: ${message}`);
  process.exitCode = 1;
}

const { mainPromise } = require("../dist/nemoclaw");
Promise.resolve(mainPromise).catch(reportTopLevelCliError);
