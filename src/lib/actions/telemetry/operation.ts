// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { openRegularFileNoFollow } from "../../adapters/fs/regular-file";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding/identity";
import { findSandboxAcrossGatewayRoots } from "../../state/registry/cross-port";
import { isPublishedSandboxRegistration } from "../../state/registry/route-reservation";
import type {
  TelemetryOperation,
  TelemetryOperationContext,
  TelemetryOutcome,
  TelemetryScope,
  TelemetryState,
  TelemetryTargetReceipt,
} from "../../domain/telemetry/event";
import { readTelemetryTestLabel, TELEMETRY_OPERATIONS } from "../../domain/telemetry/event";
import {
  allowedTelemetryCollection,
  resolveTelemetryDeliveryConfig,
  shouldSuppressTelemetry,
  telemetryRuntime,
} from "../../adapters/telemetry/http";

export const TELEMETRY_DEADLINE_MS = 5_000;
export const TELEMETRY_CONTEXT_ENV = "NEMOCLAW_TELEMETRY_CONTEXT_DIR";
interface Context {
  directory: string;
  owner: boolean;
  consumed: boolean;
}
const active = new AsyncLocalStorage<Context>();

function privateDescriptor(directory: string, file: string, limit: number, flags: number): number {
  const descriptor = fs.openSync(
    path.join(directory, file),
    flags | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > limit ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Invalid telemetry receipt");
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}
function privateFile(directory: string, file: string, limit: number): string {
  const opened = openRegularFileNoFollow(path.join(directory, file));
  try {
    const stat = opened.stat();
    if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
      throw new Error("Invalid telemetry receipt");
    return opened.readBytes(limit).toString("utf8");
  } finally {
    opened.close();
  }
}
function readMetadata(
  directory: string,
): TelemetryOperationContext & { contextOwner: "cli" | "installer" } {
  const metadata = JSON.parse(privateFile(directory, "metadata.json", 16_384));
  if (
    !metadata ||
    !TELEMETRY_OPERATIONS.includes(metadata.operation) ||
    !["cli", "installer"].includes(metadata.contextOwner) ||
    typeof metadata.startedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(metadata.startedAt)
  )
    throw new Error("Invalid telemetry context");
  return metadata;
}

function inheritedContext(): Context | null {
  if (shouldSuppressTelemetry(process.env)) return null;
  const directory = process.env[TELEMETRY_CONTEXT_ENV];
  if (!directory) return null;
  try {
    const stat = fs.lstatSync(directory);
    if (
      path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
      !/^nemoclaw-operation-[A-Za-z0-9]+$/.test(path.basename(directory)) ||
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      return null;
    readMetadata(directory);
    return { directory, owner: false, consumed: false };
  } catch {
    return null;
  }
}

function context(): Context | null {
  const label = readTelemetryTestLabel(process.env);
  if (
    shouldSuppressTelemetry(process.env) ||
    label === null ||
    (telemetryRuntime.config && !allowedTelemetryCollection(telemetryRuntime.config, label))
  )
    return null;
  const current = active.getStore() ?? inheritedContext();
  return !telemetryRuntime.config && current?.owner ? null : current;
}
export function isTelemetryOperationActive(): boolean {
  return context() !== null;
}

function appendReceipt(value: unknown): void {
  const current = context();
  if (!current || current.consumed) return;
  let descriptor: number | undefined;
  try {
    descriptor = privateDescriptor(
      current.directory,
      "receipts.ndjson",
      1_048_576,
      fs.constants.O_WRONLY | fs.constants.O_APPEND,
    );
    fs.writeFileSync(descriptor, JSON.stringify(value) + "\n");
  } catch {
    /* Telemetry cannot change command behavior. */
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {}
    }
  }
}

export function recordTelemetryTarget(receipt: TelemetryTargetReceipt): void {
  if (!isTelemetryOperationActive()) return;
  let gatewayName = receipt.gatewayName;
  if (receipt.sandboxName) {
    try {
      const entry = findSandboxAcrossGatewayRoots(receipt.sandboxName)?.entry;
      if (entry && isPublishedSandboxRegistration(entry))
        gatewayName = resolveSandboxGatewayName(entry);
    } catch {
      /* A receipt remains best effort when registry identity cannot be read. */
    }
  }
  appendReceipt({
    kind: "target",
    ...receipt,
    ...(gatewayName === undefined ? {} : { gatewayName }),
  });
}
export function setTelemetryOutcome(
  outcome: TelemetryOutcome,
  state: TelemetryState,
  scope?: TelemetryScope,
): void {
  const current = context();
  if (current?.owner) appendReceipt({ kind: "outcome", outcome, state, scope });
}
export function recordTelemetryVersions(versions: {
  previous?: string;
  target?: string;
  installed?: string;
}): void {
  appendReceipt({ kind: "versions", ...versions });
}
function readReceipts(current: Context): Record<string, unknown>[] {
  return privateFile(current.directory, "receipts.ndjson", 1_048_576)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
export function getTelemetryTarget(
  sandboxName: string,
  gatewayName?: string,
): TelemetryTargetReceipt | null {
  const current = context();
  if (!current) return null;
  try {
    const receipt = readReceipts(current)
      .reverse()
      .find(
        (item) =>
          item.kind === "target" &&
          item.sandboxName === sandboxName &&
          (gatewayName === undefined || item.gatewayName === gatewayName),
      );
    if (!receipt) return null;
    const { kind: _kind, ...target } = receipt;
    return target as unknown as TelemetryTargetReceipt;
  } catch {
    return null;
  }
}
export function getTelemetryExpectedVersion(): string | null {
  const current = context();
  if (!current) return null;
  try {
    const latest = readReceipts(current)
      .reverse()
      .find((item) => item.kind === "versions" && typeof item.target === "string");
    return (
      (latest?.target as string | undefined) ??
      readMetadata(current.directory).targetVersion ??
      null
    );
  } catch {
    return null;
  }
}
function usedEvidenceMs(current: Context): number {
  return readReceipts(current).reduce(
    (used, receipt) =>
      used +
      (receipt.kind === "budget" && typeof receipt.ms === "number" && Number.isFinite(receipt.ms)
        ? Math.max(0, receipt.ms)
        : 0),
    0,
  );
}

/** Only collection time consumes the budget; the user's operation may take minutes. */
export async function withTelemetryEvidence<T>(
  read: (remainingMs: number, signal: AbortSignal) => Promise<T>,
): Promise<T | null> {
  const current = context();
  if (!current) return null;
  const started = performance.now();
  let remainingMs: number;
  try {
    remainingMs = TELEMETRY_DEADLINE_MS - usedEvidenceMs(current);
  } catch {
    return null;
  }
  if (remainingMs <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs);
  try {
    return await Promise.race([
      read(remainingMs, controller.signal),
      new Promise<null>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve(null), { once: true }),
      ),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
    appendReceipt({ kind: "budget", ms: Math.ceil(performance.now() - started) });
  }
}

function terminalContext(current: Context, exitCode = 0): TelemetryOperationContext {
  const { contextOwner, ...metadata } = readMetadata(current.directory);
  const targets = new Map<string, TelemetryTargetReceipt>();
  let explicit: Record<string, unknown> | undefined;
  let threw = false;
  for (const receipt of readReceipts(current)) {
    if (receipt.kind === "target") {
      const { kind: _kind, ...target } = receipt;
      const key = JSON.stringify([
        target.scope,
        target.gatewayName ?? "",
        target.sandboxName ?? "",
      ]);
      const previous = targets.get(key);
      if (previous?.verificationStatus === "collection_error")
        target.verificationStatus = "collection_error";
      if (previous?.metadataErrors?.length)
        target.metadataErrors = [
          ...previous.metadataErrors,
          ...(Array.isArray(target.metadataErrors) ? target.metadataErrors : []),
        ];
      targets.set(key, target as unknown as TelemetryTargetReceipt);
    } else if (receipt.kind === "outcome") explicit = receipt;
    else if (receipt.kind === "failed") threw = true;
    else if (receipt.kind === "versions") {
      if (typeof receipt.previous === "string") metadata.previousVersion = receipt.previous;
      if (typeof receipt.target === "string") metadata.targetVersion = receipt.target;
      if (typeof receipt.installed === "string") metadata.installedVersion = receipt.installed;
    }
  }
  metadata.targets = [...targets.values()];
  const outcomes = metadata.targets.map((target) => target.outcome);
  metadata.outcome =
    (explicit?.outcome as TelemetryOutcome | undefined) ??
    (outcomes.includes("failed")
      ? "failed"
      : outcomes.includes("unverified")
        ? "unverified"
        : outcomes.includes("cancelled")
          ? "cancelled"
          : outcomes.includes("skipped")
            ? "skipped"
            : outcomes.includes("checked")
              ? "checked"
              : outcomes.includes("completed")
                ? "completed"
                : outcomes.length
                  ? "no_change"
                  : "unverified");
  const states = metadata.targets.map((target) => target.state);
  metadata.state =
    (explicit?.state as TelemetryState | undefined) ??
    (states.includes("partial") || (new Set(states).size > 1 && states.includes("applied"))
      ? "partial"
      : states.includes("pending")
        ? "pending"
        : states.includes("applied")
          ? "applied"
          : states.includes("unavailable")
            ? "unavailable"
            : "unchanged");
  if (
    metadata.outcome !== "checked" &&
    (outcomes.includes("failed") ||
      outcomes.includes("unverified") ||
      (metadata.outcome === "completed" && states.includes("partial")))
  ) {
    metadata.outcome = outcomes.includes("failed") ? "failed" : "unverified";
    metadata.state =
      states.includes("applied") || states.includes("pending") || states.includes("partial")
        ? "partial"
        : states.every((state) => state === "unchanged")
          ? "unchanged"
          : "unavailable";
  }
  if (
    states.includes("partial") ||
    (new Set(states).size > 1 && (states.includes("applied") || states.includes("pending")))
  )
    metadata.state = "partial";
  else if (states.includes("pending") && metadata.state === "applied") metadata.state = "pending";
  if (explicit?.scope) metadata.scope = explicit.scope as TelemetryScope;
  else if (
    metadata.targets.length &&
    new Set(metadata.targets.map((target) => target.scope)).size === 1
  )
    metadata.scope = metadata.targets[0].scope;
  if (
    (threw ||
      (exitCode !== 0 &&
        !(
          (contextOwner === "installer" ||
            (metadata.operation === "update" && explicit?.installer === true)) &&
          (exitCode === 10 || exitCode === 11) &&
          metadata.outcome === "unverified" &&
          metadata.state === "pending"
        ))) &&
    metadata.outcome !== "checked" &&
    metadata.outcome !== "cancelled" &&
    metadata.outcome !== "skipped"
  ) {
    metadata.outcome = "failed";
    if (states.includes("applied") || states.includes("pending") || states.includes("partial"))
      metadata.state = "partial";
  }
  metadata.completedAt = new Date().toISOString();
  return metadata;
}

function claim(current: Context): boolean {
  try {
    fs.closeSync(fs.openSync(path.join(current.directory, "claimed"), "wx", 0o600));
    return true;
  } catch {
    return false;
  }
}

export async function finishTelemetryOperation(
  exitCode = Number(process.exitCode ?? 0),
): Promise<void> {
  const current = context();
  if (!current?.owner || current.consumed || shouldSuppressTelemetry(process.env)) return;
  finishOnExit(current, exitCode);
}

function finishOnExit(current: Context, exitCode: number): void {
  const config = telemetryRuntime.config;
  if (
    !config ||
    shouldSuppressTelemetry(process.env) ||
    !allowedTelemetryCollection(config, readTelemetryTestLabel(process.env)) ||
    current.consumed ||
    !claim(current)
  )
    return;
  current.consumed = true;
  const preparationStarted = performance.now();
  try {
    const remainingMs = TELEMETRY_DEADLINE_MS - usedEvidenceMs(current);
    if (remainingMs <= 100) return;
    const deadlineAt = Date.now() + remainingMs - Math.ceil(performance.now() - preparationStarted);
    const input = JSON.stringify({
      context: terminalContext(current, exitCode),
      remainingMs: remainingMs - 100,
      deadlineAt: deadlineAt - 100,
      config: { endpoint: config.endpoint.href, localReceiver: config.localReceiver === true },
    });
    const timeout = remainingMs - Math.ceil(performance.now() - preparationStarted);
    if (timeout <= 100) return;
    // Node normalizes this process-group option for spawnSync; its typings omit it.
    const options: SpawnSyncOptions & { detached: boolean } = {
      input,
      stdio: ["pipe", "ignore", "ignore"],
      timeout,
      killSignal: "SIGKILL",
      detached: process.platform !== "win32",
      env: { ...process.env, [TELEMETRY_CONTEXT_ENV]: undefined },
    };
    const result = spawnSync(
      process.execPath,
      [path.resolve(__dirname, "../../cli/telemetry-delivery-entry.js")],
      options,
    );
    if (process.platform !== "win32" && result.pid) {
      try {
        process.kill(-result.pid, "SIGKILL");
      } catch {
        /* The sender's owned process group has already exited. */
      }
    }
  } catch {
    /* An explicit process exit still preserves its original status. */
  }
}

export async function withTelemetryOperation<T>(
  operation: TelemetryOperation | null,
  run: () => Promise<T>,
): Promise<T> {
  if (
    !operation ||
    shouldSuppressTelemetry(process.env) ||
    !resolveTelemetryDeliveryConfig(process.env)
  )
    return run();
  const nested = context();
  if (nested) return active.run(nested, run);
  const directory = createContextDirectory(operation, "cli", new Date().toISOString());
  if (!directory) return run();
  const current: Context = { directory, owner: true, consumed: false };
  const previousDirectory = process.env[TELEMETRY_CONTEXT_ENV];
  process.env[TELEMETRY_CONTEXT_ENV] = directory;
  const onExit = (code: number) => {
    finishOnExit(current, code);
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {}
  };
  process.once("exit", onExit);
  return active.run(current, async () => {
    try {
      return await run();
    } catch (error) {
      appendReceipt({ kind: "failed" });
      throw error;
    } finally {
      await finishTelemetryOperation();
      process.removeListener("exit", onExit);
      if (previousDirectory === undefined) delete process.env[TELEMETRY_CONTEXT_ENV];
      else process.env[TELEMETRY_CONTEXT_ENV] = previousDirectory;
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {}
    }
  });
}

function createContextDirectory(
  operation: TelemetryOperation,
  contextOwner: "cli" | "installer",
  startedAt: string,
): string | null {
  let directory: string | undefined;
  try {
    removeAbandonedContexts();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-operation-"));
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(
      path.join(directory, "metadata.json"),
      JSON.stringify({
        operation,
        contextOwner,
        startedAt,
        completedAt: "",
        outcome: "unverified",
        state: "unchanged",
        scope:
          contextOwner === "installer" || operation === "install" || operation === "update"
            ? "cli"
            : "sandbox",
        targets: [],
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(directory, "receipts.ndjson"), "", { mode: 0o600 });
    return directory;
  } catch {
    if (directory) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {}
    }
    return null;
  }
}

function removeAbandonedContexts(): void {
  if (!process.getuid) return;
  const temporaryRoot = os.tmpdir();
  const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
  try {
    for (const name of fs.readdirSync(temporaryRoot)) {
      if (!/^nemoclaw-operation-[A-Za-z0-9]+$/.test(name)) continue;
      const directory = path.join(temporaryRoot, name);
      try {
        const stat = fs.lstatSync(directory);
        if (
          !stat.isDirectory() ||
          stat.uid !== process.getuid() ||
          (stat.mode & 0o777) !== 0o700 ||
          stat.mtimeMs >= cutoff
        )
          continue;
        const files = fs.readdirSync(directory);
        if (
          (files.length !== 2 && files.length !== 3) ||
          !files.includes("metadata.json") ||
          !files.includes("receipts.ndjson") ||
          files.some((file) => !["metadata.json", "receipts.ndjson", "claimed"].includes(file))
        )
          continue;
        const metadata = fs.lstatSync(path.join(directory, "metadata.json"));
        if (
          !metadata.isFile() ||
          metadata.uid !== process.getuid() ||
          (metadata.mode & 0o777) !== 0o600
        )
          continue;
        readMetadata(directory);
        const receipts = fs.lstatSync(path.join(directory, "receipts.ndjson"));
        if (
          !receipts.isFile() ||
          receipts.uid !== process.getuid() ||
          (receipts.mode & 0o777) !== 0o600
        )
          continue;
        if (files.includes("claimed")) {
          const claimed = fs.lstatSync(path.join(directory, "claimed"));
          if (
            !claimed.isFile() ||
            claimed.uid !== process.getuid() ||
            (claimed.mode & 0o777) !== 0o600
          )
            continue;
        }
        fs.rmSync(directory, { recursive: true });
      } catch {
        /* A stale or untrusted entry cannot change the operation. */
      }
    }
  } catch {
    /* Temporary-directory inspection cannot change the operation. */
  }
}

/** The shell owns its terminal boundary; only transient receipts are shared with children. */
export function beginInstallerTelemetry(operation: "install" | "update"): string | null {
  const parent = context();
  if (parent) return parent.directory;
  if (shouldSuppressTelemetry(process.env) || !resolveTelemetryDeliveryConfig(process.env))
    return null;
  const started = process.env.NEMOCLAW_TELEMETRY_INSTALLER_STARTED_AT;
  const startedAt =
    started &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(started) &&
    Number.isFinite(Date.parse(started))
      ? started
      : new Date().toISOString();
  return createContextDirectory(operation, "installer", startedAt);
}

export async function finishInstallerTelemetry(
  directory: string,
  outcome: TelemetryOutcome,
  state: TelemetryState,
  scope: TelemetryScope,
  exitCode: number,
  versions: { previous?: string; target?: string; installed?: string } = {},
): Promise<void> {
  const inherited = inheritedContext();
  if (!inherited || inherited.directory !== directory) return;
  let installerOwned: boolean;
  try {
    const metadata = readMetadata(directory);
    installerOwned = metadata.contextOwner === "installer";
    if (!installerOwned && metadata.operation !== "update") return;
  } catch {
    return;
  }
  // Begin and finish run in separate installer processes.
  resolveTelemetryDeliveryConfig(process.env);
  const current: Context = { ...inherited, owner: installerOwned };
  await active.run(current, async () => {
    if (installerOwned) setTelemetryOutcome(outcome, state, scope);
    else appendReceipt({ kind: "outcome", outcome, state, scope, installer: true });
    recordTelemetryVersions(versions);
    if (installerOwned) await finishTelemetryOperation(exitCode);
  });
  if (installerOwned) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {}
  }
}
