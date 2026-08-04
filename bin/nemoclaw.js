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
const { mainPromise } = require("../dist/nemoclaw");
mainPromise.catch((error) => {
  const message = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ");
  log.error(`Error: ${message}`);
  process.exitCode = 1;
});
