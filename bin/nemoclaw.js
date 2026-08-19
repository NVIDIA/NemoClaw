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

try {
  const { mainPromise } = require("../dist/nemoclaw");
  mainPromise.catch(handleTopLevelError);
} catch (error) {
  handleTopLevelError(error);
}
