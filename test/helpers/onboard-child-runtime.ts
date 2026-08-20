// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MIN_OLLAMA_VERSION } from "../../src/lib/inference/ollama-version.js";

export const onboardChildRuntimeSource = String.raw`
function supportedOllamaHostMetadataOutput(command) {
  if (command.includes("ollama --version")) {
    return ${JSON.stringify(`ollama version is ${MIN_OLLAMA_VERSION}`)};
  }
  if (command.includes("/api/version")) {
    return ${JSON.stringify(JSON.stringify({ version: MIN_OLLAMA_VERSION }))};
  }
  if (
    command.includes("command -v ollama") ||
    (command.includes("command -v") && command.includes("\"$1\"") && command.endsWith("-- ollama"))
  ) {
    return "/usr/bin/ollama";
  }
  return "";
}

function installPromptQueue(target, configuredAnswers) {
  const answers = [...configuredAnswers];
  const messages = [];
  const prompts = [];
  target.prompt = async (message, options = {}) => {
    messages.push(message);
    prompts.push({ message, secret: options.secret === true });
    if (answers.length === 0) {
      throw new Error("Unexpected prompt after scripted answers were exhausted: " + message);
    }
    return answers.shift();
  };
  return { answers, messages, prompts };
}

async function captureChildConsole(run) {
  const originalLog = console.log;
  const originalError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    return { value: await run(), lines };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function reportChildScenario(run) {
  const hostLog = console.log;
  captureChildConsole(run)
    .then(({ value, lines }) => hostLog(JSON.stringify({ ...value, lines })))
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
}
`;
