// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RebuildTransactionStore } from "../src/lib/state/rebuild-transaction";
import { intent, preparedReceipts, SANDBOX } from "./helpers/rebuild-transaction-store";

const roots: string[] = [];
const requireSource = createRequire(import.meta.url);
const storeModule = requireSource.resolve("../src/lib/state/rebuild-transaction.js");

const writerScript = String.raw`
const fs = require("node:fs");
const { RebuildTransactionStore } = require(process.argv[1]);
const stateDir = process.argv[2];
const gate = process.argv[3];
const code = process.argv[4];
fs.writeFileSync(gate + "." + code + ".ready", "");
(async () => {
  while (!fs.existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    const record = await new RebuildTransactionStore({ stateDir }).recordFailure("transaction-test", 1, {
      code,
      recordedAt: "2026-07-08T00:00:30.000Z",
      retryable: true,
    });
    process.stdout.write(JSON.stringify({ ok: true, record }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
  }
})().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
`;

function startWriter(
  stateDir: string,
  gate: string,
  code: string,
): Promise<{ ok: boolean; code?: string; record?: unknown }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", writerScript, storeModule, stateDir, gate, code], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode !== 0) reject(new Error(stderr || `writer exited ${String(exitCode)}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

async function waitForReady(gate: string, codes: string[]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (codes.every((code) => fs.existsSync(`${gate}.${code}.ready`))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for transaction writers");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("RebuildTransactionStore cross-process serialization", () => {
  it("allows one writer to advance and rejects the stale process", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-transaction-process-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const gate = path.join(root, "start");
    const store = new RebuildTransactionStore({ stateDir });
    await store.create(intent(), preparedReceipts());

    const writers = [
      startWriter(stateDir, gate, "PROCESS_A"),
      startWriter(stateDir, gate, "PROCESS_B"),
    ];
    await waitForReady(gate, ["PROCESS_A", "PROCESS_B"]);
    fs.writeFileSync(gate, "go");
    const results = await Promise.all(writers);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.code === "REVISION_CONFLICT")).toHaveLength(1);
    expect(store.load(SANDBOX)).toEqual(results.find((result) => result.ok)?.record);
  }, 15_000);
});
