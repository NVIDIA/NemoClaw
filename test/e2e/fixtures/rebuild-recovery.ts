// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ArtifactSink } from "./artifacts.ts";
import { resultText } from "./clients/command.ts";
import type { HostCliClient } from "./clients/host.ts";
import type { ShellProbeRunOptions } from "./shell-probe.ts";

export type LiveRebuildInterruptionPhase = "old_deleted" | "replacement_unjournaled";

export interface RebuildTransactionEvidence {
  transactionId: string;
  sandboxName: string;
  revision: number;
  status: "active" | "completed";
  phase: "old_deleted" | "completed";
  createdAt: string;
  completedAt: string | null;
  receipts: { backup: boolean; oldSandboxDeletion: boolean; replacement: boolean };
  target: {
    gatewayName: string;
    gatewayPort: number;
    imageFingerprint: string;
    configurationFingerprint: string;
  };
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

export interface RebuildRegistryEvidence {
  agent: string | null;
  defaultSandbox: string | null;
  sandboxName: string;
  gatewayName: string;
  gatewayPort: number;
  agentVersion: string;
  nemoclawVersion: string;
  observabilityEnabled: boolean;
  policies: string[];
  toolDisclosure: string;
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

type JsonObject = Record<string, unknown>;

export async function startRebuildAtDurableBoundary(
  options: StartInterruptedRebuildOptions,
): Promise<PausedRebuildProcess> {
  const home = readText(options.env.HOME, "rebuild interruption HOME");
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
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
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
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${options.redact(`${stdout}\n${stderr}`).trim()}`,
    );
  }

  return { pid: child.pid!, kill };
}

export function readInterruptedRebuildEvidence(
  sandboxName: string,
  interruption: LiveRebuildInterruptionPhase,
  home: string,
): RebuildInterruptionEvidence {
  const record = readObject(transactionPath(home, sandboxName), "rebuild transaction");
  const base = projectTransaction(record, sandboxName, "active");
  if (base.phase !== "old_deleted" || base.receipts.replacement) {
    throw new Error("interrupted transaction is not at durable old_deleted");
  }

  let replacement: RebuildInterruptionEvidence["replacement"] = null;
  if (interruption === "replacement_unjournaled") {
    const registry = readObject(path.join(home, ".nemoclaw", "sandboxes.json"), "registry");
    const entry = readObjectValue(
      readObjectValue(registry.sandboxes, "registry.sandboxes")[sandboxName],
      "replacement registry entry",
    );
    const session = readObject(path.join(home, ".nemoclaw", "onboard-session.json"), "session");
    const correlation = readObjectValue(
      readObjectValue(session.metadata, "session.metadata").rebuild,
      "session.metadata.rebuild",
    );
    if (
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
      registryGatewayName: readText(entry.gatewayName, "replacement gatewayName"),
      registryGatewayPort: readInteger(entry.gatewayPort, "replacement gatewayPort"),
      sessionTransactionId: readText(correlation.transactionId, "session transactionId"),
      sessionImageFingerprint: readFingerprint(
        correlation.imageFingerprint,
        "session imageFingerprint",
      ),
      sessionConfigurationFingerprint: readFingerprint(
        correlation.configurationFingerprint,
        "session configurationFingerprint",
      ),
      replacementFingerprint: readFingerprint(
        correlation.replacementFingerprint,
        "session replacementFingerprint",
      ),
    };
  }
  return { ...base, interruption, replacement };
}

export function readCompletedRebuildEvidence(
  sandboxName: string,
  home: string,
): RebuildTransactionEvidence {
  const evidence = projectTransaction(
    readObject(transactionPath(home, sandboxName), "rebuild transaction"),
    sandboxName,
    "completed",
  );
  if (evidence.phase !== "completed" || !evidence.receipts.replacement) {
    throw new Error("rebuild transaction is not a completed tombstone");
  }
  return evidence;
}

export function readRebuildRegistryEvidence(
  sandboxName: string,
  home: string,
): RebuildRegistryEvidence {
  const registry = readObject(path.join(home, ".nemoclaw", "sandboxes.json"), "registry");
  const entry = readObjectValue(
    readObjectValue(registry.sandboxes, "registry.sandboxes")[sandboxName],
    "registry sandbox entry",
  );
  const policies = entry.policies ?? [];
  if (!Array.isArray(policies) || !policies.every((policy) => typeof policy === "string")) {
    throw new Error("registry entry policies must be a string array");
  }
  return {
    agent: entry.agent === null ? null : readText(entry.agent, "registry entry agent"),
    defaultSandbox:
      registry.defaultSandbox === null
        ? null
        : readText(registry.defaultSandbox, "registry.defaultSandbox"),
    sandboxName,
    gatewayName: readText(entry.gatewayName, "registry entry gatewayName"),
    gatewayPort: readInteger(entry.gatewayPort, "registry entry gatewayPort"),
    agentVersion: readText(entry.agentVersion, "registry entry agentVersion"),
    nemoclawVersion: readText(entry.nemoclawVersion, "registry entry nemoclawVersion"),
    observabilityEnabled: entry.observabilityEnabled === true,
    policies: [...policies].sort(),
    toolDisclosure: readText(entry.toolDisclosure, "registry entry toolDisclosure"),
  };
}

export async function sandboxContainerIds(
  host: HostCliClient,
  sandboxName: string,
  options: ShellProbeRunOptions = {},
): Promise<string[]> {
  const result = await host.command(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=openshell.ai/sandbox-name=${sandboxName}`,
      "--format",
      "{{.ID}}",
    ],
    options,
  );
  if (result.exitCode !== 0) throw new Error(resultText(result));
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function projectTransaction(
  record: JsonObject,
  sandboxName: string,
  status: "active" | "completed",
): RebuildTransactionEvidence {
  const intent = readObjectValue(record.intent, "transaction.intent");
  const target = readObjectValue(intent.target, "transaction.intent.target");
  const receipts = readObjectValue(record.receipts, "transaction.receipts");
  const phase = status === "completed" ? "completed" : "old_deleted";
  if (record.status !== status || record.phase !== phase || intent.sandboxName !== sandboxName) {
    throw new Error(`rebuild transaction is not ${status} for ${sandboxName}`);
  }
  if (!receipts.backup || !receipts.oldSandboxDeletion) {
    throw new Error("rebuild transaction is missing destructive receipts");
  }
  return {
    transactionId: readText(record.transactionId, "transaction.transactionId"),
    sandboxName,
    revision: readInteger(record.revision, "transaction.revision"),
    status,
    phase,
    createdAt: readText(record.createdAt, "transaction.createdAt"),
    completedAt:
      status === "completed" ? readText(record.completedAt, "transaction.completedAt") : null,
    receipts: {
      backup: true,
      oldSandboxDeletion: true,
      replacement: receipts.replacement !== undefined,
    },
    target: {
      gatewayName: readText(target.gatewayName, "transaction target gatewayName"),
      gatewayPort: readInteger(target.gatewayPort, "transaction target gatewayPort"),
      imageFingerprint: readFingerprint(target.imageFingerprint, "transaction imageFingerprint"),
      configurationFingerprint: readFingerprint(
        target.configurationFingerprint,
        "transaction configurationFingerprint",
      ),
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

function transactionPath(home: string, sandboxName: string): string {
  const stem = crypto.createHash("sha256").update(sandboxName).digest("hex");
  return path.join(home, ".nemoclaw", "state", "rebuild-transactions", `${stem}.json`);
}

function readObject(file: string, label: string): JsonObject {
  return readObjectValue(JSON.parse(fs.readFileSync(file, "utf8")), label);
}

function readObjectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function readInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value as number;
}

function readFingerprint(value: unknown, label: string): string {
  const candidate = readText(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(candidate)) {
    throw new Error(`${label} must be a sha256 fingerprint`);
  }
  return candidate;
}
