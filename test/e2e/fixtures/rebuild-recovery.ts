// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Session } from "../../../src/lib/state/onboard-session";
import {
  getRebuildTransactionPath,
  type RebuildTransactionDiagnosticV1,
  type RebuildTransactionRecordV1,
} from "../../../src/lib/state/rebuild-transaction";
import type { SandboxRegistry } from "../../../src/lib/state/registry";

import type { ArtifactSink } from "./artifacts.ts";

export type LiveRebuildInterruptionPhase = "old_deleted" | "replacement_unjournaled";

export interface RebuildTransactionEvidence
  extends Omit<RebuildTransactionDiagnosticV1, "failureCode" | "phase" | "updatedAt" | "version"> {
  phase: "old_deleted" | "completed";
  target: Pick<
    RebuildTransactionRecordV1["intent"]["target"],
    "configurationFingerprint" | "gatewayName" | "gatewayPort" | "imageFingerprint"
  >;
}

export interface RebuildInterruptionEvidence extends RebuildTransactionEvidence {
  interruption: LiveRebuildInterruptionPhase;
  replacement: null | {
    registryGatewayName: string;
    registryGatewayPort: number;
    sessionTransactionId: string;
    sessionImageFingerprint: string;
    sessionConfigurationFingerprint: string;
    replacementFingerprint: string;
  };
}

export interface PausedRebuildProcess {
  pid: number;
  kill(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

interface StartInterruptedRebuildOptions {
  artifacts: ArtifactSink;
  artifactName: string;
  commandPath: string;
  env: NodeJS.ProcessEnv;
  phase: LiveRebuildInterruptionPhase;
  redact: (text: string) => string;
  sandboxName: string;
  timeoutMs: number;
}

const MAX_CAPTURED_CHARACTERS = 256 * 1024;
const MAX_ERROR_TAIL_CHARACTERS = 16 * 1024;
const OUTPUT_TRUNCATED = "\n...[earlier output truncated]...\n";

export async function startRebuildAtDurableBoundary(
  options: StartInterruptedRebuildOptions,
): Promise<PausedRebuildProcess> {
  const home = options.env.HOME;
  if (!home) throw new Error("rebuild interruption HOME is required");
  const args = [options.sandboxName, "rebuild", "--yes"];
  const child = spawn(options.commandPath, args, {
    detached: true,
    env: {
      ...options.env,
      NEMOCLAW_RUN_LIVE_E2E: "1",
      NEMOCLAW_REBUILD_PROCESS_FIXTURE: home,
      NEMOCLAW_E2E_FAILURE_INJECTION: "1",
      NEMOCLAW_E2E_FORCE_FAIL_AT_STEP: `rebuild_${options.phase}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const marker = `[e2e] Rebuild interruption point '${options.phase}'`;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = appendCapturedOutput(stdout, chunk.toString("utf8"));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendCapturedOutput(stderr, chunk.toString("utf8"));
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    },
  );
  const writeArtifacts = async (result: { code: number | null; signal: NodeJS.Signals | null }) => {
    const redactedStdout = options.redact(stdout);
    const redactedStderr = options.redact(stderr);
    await options.artifacts.writeText(`${options.artifactName}.stdout.txt`, redactedStdout);
    await options.artifacts.writeText(`${options.artifactName}.stderr.txt`, redactedStderr);
    await options.artifacts.writeJson(`${options.artifactName}.result.json`, {
      command: [options.commandPath, ...args],
      ...result,
      stdout: redactedStdout,
      stderr: redactedStderr,
    });
  };
  let killResult: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  const kill = () => {
    killResult ??= (async () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      const result = await exit;
      await writeArtifacts(result);
      if (result.signal !== "SIGKILL") {
        throw new Error(
          `rebuild interruption expected SIGKILL, got code=${String(result.code)} signal=${String(result.signal)}`,
        );
      }
      return result;
    })();
    return killResult;
  };

  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        const observe = () => (stderr.includes(marker) ? resolve() : undefined);
        child.stderr.on("data", observe);
        observe();
      }),
      exit.then(({ code, signal }) => {
        throw new Error(
          `rebuild exited before ${options.phase}: code=${String(code)} signal=${String(signal)}`,
        );
      }),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`timed out waiting for rebuild ${options.phase}`)),
          options.timeoutMs,
        ).unref();
      }),
    ]);
    await waitForStopped(child.pid!, Math.min(options.timeoutMs, 5_000));
  } catch (error) {
    await kill().catch(() => undefined);
    const outputTail = options
      .redact(`${stdout}\n${stderr}`)
      .trim()
      .slice(-MAX_ERROR_TAIL_CHARACTERS);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${outputTail}`);
  }

  return { pid: child.pid!, kill };
}

export function readInterruptedRebuildEvidence(
  sandboxName: string,
  interruption: LiveRebuildInterruptionPhase,
  home: string,
): RebuildInterruptionEvidence {
  const record = readJson<RebuildTransactionRecordV1>(
    getRebuildTransactionPath(sandboxName, path.join(home, ".nemoclaw", "state")),
  );
  const base = projectTransaction(record, sandboxName, "active");
  if (base.phase !== "old_deleted" || base.receipts.replacement) {
    throw new Error("interrupted transaction is not at durable old_deleted");
  }

  let replacement: RebuildInterruptionEvidence["replacement"] = null;
  if (interruption === "replacement_unjournaled") {
    const registry = readJson<SandboxRegistry>(path.join(home, ".nemoclaw", "sandboxes.json"));
    const entry = registry.sandboxes[sandboxName];
    const session = readJson<Session>(path.join(home, ".nemoclaw", "onboard-session.json"));
    const correlation = session.metadata.rebuild;
    if (
      !entry ||
      !correlation ||
      correlation.replacementFingerprint === null ||
      session.sandboxName !== sandboxName ||
      entry.name !== sandboxName ||
      correlation.transactionId !== base.transactionId ||
      correlation.imageFingerprint !== base.target.imageFingerprint ||
      correlation.configurationFingerprint !== base.target.configurationFingerprint
    ) {
      throw new Error("replacement session correlation does not match the rebuild transaction");
    }
    if (
      entry.gatewayName !== base.target.gatewayName ||
      entry.gatewayPort !== base.target.gatewayPort
    ) {
      throw new Error("replacement registry gateway does not match the rebuild target");
    }
    replacement = {
      registryGatewayName: entry.gatewayName,
      registryGatewayPort: entry.gatewayPort,
      sessionTransactionId: correlation.transactionId,
      sessionImageFingerprint: correlation.imageFingerprint,
      sessionConfigurationFingerprint: correlation.configurationFingerprint,
      replacementFingerprint: correlation.replacementFingerprint,
    };
  }
  return { ...base, interruption, replacement };
}

export function readCompletedRebuildEvidence(
  sandboxName: string,
  home: string,
): RebuildTransactionEvidence {
  const evidence = projectTransaction(
    readJson<RebuildTransactionRecordV1>(
      getRebuildTransactionPath(sandboxName, path.join(home, ".nemoclaw", "state")),
    ),
    sandboxName,
    "completed",
  );
  if (evidence.phase !== "completed" || !evidence.receipts.replacement) {
    throw new Error("rebuild transaction is not a completed tombstone");
  }
  return evidence;
}

function projectTransaction(
  record: RebuildTransactionRecordV1,
  sandboxName: string,
  status: "active" | "completed",
): RebuildTransactionEvidence {
  const { intent, receipts } = record;
  const { target } = intent;
  const phase = status === "completed" ? "completed" : "old_deleted";
  if (record.status !== status || record.phase !== phase || intent.sandboxName !== sandboxName) {
    throw new Error(`rebuild transaction is not ${status} for ${sandboxName}`);
  }
  if (!receipts.backup || !receipts.oldSandboxDeletion) {
    throw new Error("rebuild transaction is missing destructive receipts");
  }
  return {
    transactionId: record.transactionId,
    sandboxName,
    revision: record.revision,
    status,
    phase,
    createdAt: record.createdAt,
    completedAt: status === "completed" ? record.completedAt : null,
    receipts: {
      backup: true,
      oldSandboxDeletion: true,
      replacement: receipts.replacement !== undefined,
    },
    target: {
      gatewayName: target.gatewayName,
      gatewayPort: target.gatewayPort,
      imageFingerprint: target.imageFingerprint,
      configurationFingerprint: target.configurationFingerprint,
    },
  };
}

async function waitForStopped(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
      if (state.startsWith("T")) return;
    } catch {
      // The exit promise reports an early process death with captured output.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`rebuild process ${String(pid)} did not enter SIGSTOP state`);
}

function appendCapturedOutput(current: string, chunk: string): string {
  const combined = current + chunk;
  if (combined.length <= MAX_CAPTURED_CHARACTERS) return combined;
  return OUTPUT_TRUNCATED + combined.slice(-(MAX_CAPTURED_CHARACTERS - OUTPUT_TRUNCATED.length));
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}
