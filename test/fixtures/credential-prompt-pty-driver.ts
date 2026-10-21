// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { prompt } from "../../src/lib/credentials/store";

const statePath = process.env.NEMOCLAW_PROMPT_PTY_STATE;
if (!statePath) throw new Error("NEMOCLAW_PROMPT_PTY_STATE is required");

async function main(): Promise<void> {
  const first = await prompt("first: ");
  if (first !== "alpha") throw new Error(`unexpected first answer: ${first}`);

  fs.writeFileSync(statePath, JSON.stringify({ status: "in_progress", resumable: true }));
  process.stdout.write("BETWEEN_PROMPTS\n");

  await new Promise((resolve) => setTimeout(resolve, 200));

  try {
    await prompt("second: ");
    throw new Error("second prompt unexpectedly resolved");
  } catch (error) {
    const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
    process.stdout.write(`CANCEL_CODE=${String(code)}\n`);
    process.stdout.write(`TTY_RAW=${String(process.stdin.isRaw === true)}\n`);
    process.exitCode = 42;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
