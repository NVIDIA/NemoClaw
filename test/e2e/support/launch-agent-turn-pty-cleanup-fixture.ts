// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OPENCLAW_SESSION_EVIDENCE_SCRIPT } from "../live/launch-agent-turn.ts";

type CleanupScenario =
  | "retired"
  | "persistent"
  | "changed-root"
  | "changed-socket"
  | "unknown-entry";

async function closeServer(server: Server | undefined): Promise<void> {
  if (server?.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
}

export async function runPtyMonitorCleanupFixture(scenario: CleanupScenario) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "p-"));
  let primaryServer: Server | undefined;
  let replacementServer: Server | undefined;
  let stopChild: (() => Promise<void>) | undefined;
  try {
    const runId = randomUUID().replaceAll("-", "");
    const baselinePath = `/tmp/nemoclaw-launch-session-${runId}.json`;
    const ptyMonitorRoot = `/tmp/nemoclaw-launch-turn-${runId}`;
    const guestRoot = join(fixtureRoot, "g");
    const socketPath = join(guestRoot, "pty-input-mode.sock");
    mkdirSync(guestRoot, { mode: 0o700 });
    chmodSync(guestRoot, 0o700);
    primaryServer = createServer();
    await listen(primaryServer, socketPath);
    const hostMonitorExistedAtStart = existsSync(ptyMonitorRoot);
    // Only the sandbox-side verifier sees this socket. Host path probes cannot wait for it.
    const namespaceAdapter = `{
      const fs = require("node:fs");
      const root = ${JSON.stringify(ptyMonitorRoot)};
      const guest = ${JSON.stringify(guestRoot)};
      let announced = false;
      for (const operation of ["lstatSync", "readdirSync", "rmdirSync", "openSync"]) {
        const original = fs[operation].bind(fs);
        fs[operation] = (file, ...args) => {
          const mapped = file === "/tmp" ? ${JSON.stringify(fixtureRoot)}
            : typeof file === "string" && (file === root || file.startsWith(root + "/"))
              ? guest + file.slice(root.length) : file;
          const result = original(mapped, ...args);
          if (!announced && operation === "lstatSync" && file === root + "/pty-input-mode.sock") {
            announced = true;
            process.stdout.write("cleanup-snapshot\\n");
          }
          return result;
        };
      }
    }
    `;
    const child = spawn(
      process.execPath,
      [
        "-e",
        namespaceAdapter + OPENCLAW_SESSION_EVIDENCE_SCRIPT,
        "cleanup-pty",
        fixtureRoot,
        baselinePath,
        "",
        ptyMonitorRoot,
        runId,
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL" },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const finished = new Promise<{ signal: NodeJS.Signals | null; status: number | null }>(
      (resolve) => {
        child.once("close", (status, signal) => resolve({ signal, status }));
      },
    );
    stopChild = async () => {
      child.kill("SIGKILL");
      await finished;
    };
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (stdout.includes("cleanup-snapshot\n")) resolve();
      });
      child.once("error", reject);
      child.once("close", () =>
        reject(new Error(`cleanup exited before socket observation: ${stderr}`)),
      );
    });
    if (scenario === "retired") {
      await closeServer(primaryServer);
    } else if (scenario === "changed-root") {
      renameSync(guestRoot, join(fixtureRoot, "original-root"));
      mkdirSync(guestRoot, { mode: 0o700 });
      chmodSync(guestRoot, 0o700);
    } else if (scenario === "changed-socket") {
      const replacement = join(fixtureRoot, "replacement.sock");
      replacementServer = createServer();
      await listen(replacementServer, replacement);
      renameSync(replacement, socketPath);
    } else if (scenario === "unknown-entry") {
      writeFileSync(join(guestRoot, "unexpected"), "owned fixture residue");
    }
    return {
      ...(await finished),
      guestRootExists: existsSync(guestRoot),
      hostMonitorExistedAtStart,
      hostMonitorExists: existsSync(ptyMonitorRoot),
      socketExists: existsSync(socketPath),
      stderr,
    };
  } finally {
    try {
      await stopChild?.();
    } finally {
      try {
        await closeServer(primaryServer);
      } finally {
        try {
          await closeServer(replacementServer);
        } finally {
          rmSync(fixtureRoot, { force: true, recursive: true });
        }
      }
    }
  }
}
