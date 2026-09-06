#!/usr/bin/env node
// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const invokedAs = require("node:path").basename(process.argv[1] || "");
if (invokedAs === "nemo-deepagents") {
  process.env.NEMOCLAW_AGENT = "langchain-deepagents-code";
  process.env.NEMOCLAW_INVOKED_AS = "nemo-deepagents";
}

let topLevelLog = null;
try {
  topLevelLog = require("../dist/lib/cli/logger").log;
} catch {
  topLevelLog = null;
}

const PORT_ENV_NAME =
  "NEMOCLAW_(?:GATEWAY|DASHBOARD|VLLM|OLLAMA|OLLAMA_PROXY|BEDROCK_RUNTIME_ADAPTER|OPENROUTER_RUNTIME_ADAPTER|HTTPS_PIN_RUNTIME_ADAPTER)_PORT";
const SAFE_PORT_DIAGNOSTIC = new RegExp(
  `^Invalid port: ${PORT_ENV_NAME}="\\d{1,5}" — (?:must be an integer between 1024 and 65535|must not overlap the 18789-18799 dashboard port range|must not overlap the (?:llama\\.cpp inference|vLLM / NIM inference|Ollama inference|Ollama auth proxy|Bedrock Runtime adapter|OpenRouter Runtime adapter|HTTPS Pin Runtime adapter) default port \\(\\d{1,5}\\)|conflicts with ${PORT_ENV_NAME} \\(\\d{1,5}\\)|conflicts with the fixed llama\\.cpp inference port \\(8081\\))$`,
);

function redactFallbackMessage(message) {
  try {
    const { redactForLog } = require("../dist/lib/security/redact");
    const redacted = redactForLog(message);
    return typeof redacted === "string" ? redacted : "Command failed.";
  } catch {
    return SAFE_PORT_DIAGNOSTIC.test(message) ? message : "Command failed.";
  }
}

function handleTopLevelError(error) {
  let message = "Command failed.";
  try {
    message = String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, " ");
  } catch {
    // Keep the top-level rejection handler reliable even for values with throwing coercion hooks.
  }
  process.exitCode = 1;
  try {
    if (topLevelLog) {
      topLevelLog.error(`Error: ${message}`);
      return;
    }
    process.stderr.write(`Error: ${redactFallbackMessage(message)}\n`);
  } catch {
    try {
      process.stderr.write("Error: Command failed.\n");
    } catch {
      // The diagnostic sink itself failed; there is nothing left to report safely.
    }
  }
}

let compiledCliPath;
try {
  compiledCliPath = require.resolve("../dist/nemoclaw");
} catch (error) {
  // Resolving the entrypoint does not execute it, so MODULE_NOT_FOUND here
  // identifies the incomplete-install case without hiding a nested dependency failure.
  if (error && error.code === "MODULE_NOT_FOUND") {
    process.exitCode = 1;
    try {
      process.stderr.write(
        "Error: NemoClaw's compiled CLI is missing or incomplete, so no command can run.\n" +
          "  An install or upgrade did not finish.\n" +
          "  Rerun the installer command that you used to install NemoClaw to finish the installation.\n" +
          "  The installer attempts to recover existing sandboxes. Follow any recovery guidance that it reports.\n",
      );
    } catch {
      // The diagnostic sink itself failed; there is nothing left to report safely.
    }
  } else {
    handleTopLevelError(error);
  }
}

if (compiledCliPath) {
  try {
    const { mainPromise } = require(compiledCliPath);
    mainPromise.catch(handleTopLevelError);
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") {
      handleTopLevelError(
        new Error(
          "NemoClaw's compiled CLI could not start because a required module is unavailable. " +
            "Rerun the installer command that you used to install NemoClaw; if the problem continues, report the startup failure.",
        ),
      );
    } else {
      handleTopLevelError(error);
    }
  }
}
