// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { ownChildProcess } from "../../helpers/child-process-lifecycle.ts";
import { ollamaCleanupScript } from "../live/gpu-e2e-helpers.ts";

async function runCleanupFixture(termination: string, sleepCommand: string) {
  const root = mkdtempSync(path.join(tmpdir(), "nemoclaw-ollama-shutdown-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const sleepLog = path.join(root, "sleeps");
  writeFileSync(sleepLog, "");
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  expect(address).toMatchObject({ address: "127.0.0.1" });
  const port = (address as { port: number }).port;
  const closed = once(server, "close");
  server.close();
  await closed;
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const sleepLog = ${JSON.stringify(sleepLog)};
    process.on("SIGTERM", () => { ${termination} });
    setInterval(() => {}, 1000);
    process.send("ready");
  `,
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  const owner = ownChildProcess(child, { gracefulTimeoutMs: 20 });
  try {
    await once(child, "message");
    // Route process probes and signals only to this fixture's child, never host Ollama.
    const commands = [
      ["systemctl", "exit 1"],
      ["sudo", "exit 1"],
      ["pkill", 'case "$*" in "-f [o]llama serve") kill -TERM "$OWNED_PID" ;; *) exit 1 ;; esac'],
      ["pgrep", 'kill -0 "$OWNED_PID" 2>/dev/null'],
      ["sleep", `printf '%s\\n' "$*" >> "$SLEEP_LOG"\n${sleepCommand}`],
    ];
    for (const [name, body] of commands) {
      const filename = path.join(bin, name!);
      writeFileSync(filename, `#!/bin/sh\n${body}\n`);
      chmodSync(filename, 0o755);
    }
    const result = await new Promise<{ code: number | string; stderr: string }>((resolve) => {
      execFile(
        "bash",
        ["-c", ollamaCleanupScript(port)],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            OWNED_PID: String(child.pid),
            SLEEP_LOG: sleepLog,
          },
          timeout: 5_000,
          killSignal: "SIGKILL",
        },
        (error, _stdout, stderr) => resolve({ code: error?.code ?? 0, stderr }),
      );
    });
    return { ...result, waits: readFileSync(sleepLog, "utf8").trim().split("\n").filter(Boolean) };
  } finally {
    await owner.terminate();
    rmSync(root, { recursive: true, force: true });
  }
}

it("waits for a signaled Ollama process to finish shutdown (#14041)", async () => {
  const result = await runCleanupFixture(
    'setInterval(() => { if (require("node:fs").statSync(sleepLog).size > 0) process.exit(0); }, 10)',
    'exec /bin/sleep "$@"',
  );

  expect(result.code).toBe(0);
  expect(result.waits.length).toBeGreaterThan(0);
  expect(result.waits.length).toBeLessThanOrEqual(50);
});

it("rejects an Ollama process that survives the bounded shutdown wait (#14041)", async () => {
  const result = await runCleanupFixture("", ":");

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Ollama cleanup left a daemon process");
  expect(result.waits).toEqual(Array(50).fill("0.1"));
});
