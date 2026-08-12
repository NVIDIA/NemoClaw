// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const onboardChildRuntimeSource = String.raw`
function installPromptQueue(target, configuredAnswers) {
  const answers = [...configuredAnswers];
  const messages = [];
  const prompts = [];
  target.prompt = async (message, options = {}) => {
    messages.push(message);
    prompts.push({ message, secret: options.secret === true });
    return answers.shift() ?? "";
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
