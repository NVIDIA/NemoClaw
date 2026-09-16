// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Reuse the real native CLI dispatcher and its module cache across fixture commands.
import readline from "node:readline";
import { runCli } from "/app/dist/cli/run-main.js";
const write = process.stdout.write.bind(process.stdout);
class CliExit extends Error {
  constructor(code) {
    super("CLI exit");
    this.code = code;
  }
}
process.exit = (code) => {
  throw new CliExit(code ?? 0);
};
const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  const started = performance.now();
  let stdout = "",
    stderr = "",
    code = 0;
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => {
    stdout += chunk;
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr += chunk;
    return true;
  };
  try {
    process.exitCode = 0;
    process.argv = ["node", "/app/openclaw.mjs", ...JSON.parse(line)];
    await runCli(process.argv);
    code = Number(process.exitCode ?? 0);
  } catch (error) {
    code = error instanceof CliExit ? error.code : 1;
    if (!(error instanceof CliExit)) stderr += error.stack;
  }
  process.stdout.write = write;
  process.stderr.write = errWrite;
  write(
    JSON.stringify({ stdout, stderr, code, seconds: (performance.now() - started) / 1000 }) + "\n",
  );
  process.stdin.resume();
}
