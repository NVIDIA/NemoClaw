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

function createSuccessfulOllamaServiceExecutionProofRunner(fallback) {
  const fs = require("node:fs");
  const path = require("node:path");
  const executablePath = path.join(process.env.HOME, "ollama-service-exec-fixture");
  const interpreter = Buffer.from("/bin/sh\0", "utf8");
  const programHeaderOffset = 64;
  const interpreterOffset = programHeaderOffset + 56;
  const elf = Buffer.alloc(interpreterOffset + interpreter.length);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  elf.writeUInt16LE(2, 16);
  elf.writeUInt16LE(0x3e, 18);
  elf.writeUInt32LE(1, 20);
  elf.writeBigUInt64LE(BigInt(programHeaderOffset), 32);
  elf.writeUInt16LE(64, 52);
  elf.writeUInt16LE(56, 54);
  elf.writeUInt16LE(1, 56);
  elf.writeUInt32LE(3, programHeaderOffset);
  elf.writeBigUInt64LE(BigInt(interpreterOffset), programHeaderOffset + 8);
  elf.writeBigUInt64LE(BigInt(interpreter.length), programHeaderOffset + 32);
  interpreter.copy(elf, interpreterOffset);
  fs.writeFileSync(executablePath, elf, { mode: 0o755 });
  const failUnmatchedExecutionProof = typeof fallback !== "function";
  const runFallback =
    typeof fallback === "function"
      ? fallback
      : () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false });

  return (command, options) => {
    const argv = Array.isArray(command) ? command : [];
    const success = (stdout = "") => ({ stdout, stderr: "", exitCode: 0, timedOut: false });
    if (
      argv.length === 5 &&
      argv[0] === "/usr/bin/systemctl" &&
      argv[1] === "show" &&
      argv[2] === "ollama.service" &&
      argv[3] === "--property=User" &&
      argv[4] === "--property=ExecStart"
    ) {
      return success(
        "User=ollama\nExecStart={ path=" +
          executablePath +
          " ; argv[]=" +
          executablePath +
          " serve ; }",
      );
    }
    if (
      argv.length === 3 &&
      argv[0] === "/usr/bin/id" &&
      argv[1] === "-u" &&
      argv[2] === "ollama"
    ) {
      return success("997\n");
    }
    const commandOffset = argv[1] === "-n" ? 2 : 1;
    const executionProofArguments = [
      "--wait",
      "--pipe",
      "--collect",
      "--service-type=exec",
      "--uid=ollama",
      "--property=KillMode=control-group",
      "--property=RuntimeMaxSec=15s",
      "--property=TimeoutStopSec=250ms",
      "--property=SendSIGKILL=yes",
    ];
    if (
      argv[0] === "/usr/bin/sudo" &&
      argv[commandOffset] === "/usr/bin/env" &&
      argv[commandOffset + 1] === "LC_ALL=C" &&
      argv[commandOffset + 2] === "/usr/bin/systemd-run" &&
      executionProofArguments.every((argument) => argv.includes(argument)) &&
      argv.at(-2) === executablePath &&
      argv.at(-1) === "--version"
    ) {
      return success("ollama version is 0.11.10\n");
    }
    if (
      failUnmatchedExecutionProof &&
      argv[0] === "/usr/bin/sudo" &&
      argv.at(-2) === executablePath &&
      argv.at(-1) === "--version"
    ) {
      return {
        stdout: "",
        stderr: "Unexpected Ollama service execution-proof command",
        exitCode: 1,
        timedOut: false,
      };
    }
    return runFallback(command, options);
  };
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
