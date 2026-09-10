// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export type NativeRuntimePurpose =
  | "openclaw"
  | "hermes"
  | "pi"
  | "langchain-deepagents-code"
  | "nemocua"
  | "inference";
const PURPOSES: readonly NativeRuntimePurpose[] = [
  "openclaw",
  "hermes",
  "pi",
  "langchain-deepagents-code",
  "nemocua",
  "inference",
];
const HEX64 = /^[a-f0-9]{64}$/u;
const HEX40 = /^[a-f0-9]{40}$/u;
const NODE_VERSION = /^(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4})$/u;
const DIRECTORY = {
  openclaw: "openclaw",
  hermes: "hermes",
  pi: "pi",
  "langchain-deepagents-code": "deepagents",
  nemocua: "nemocua",
} as const;

export function validateNativeRuntimeReceipt(
  value: unknown,
  installRoot: string,
  purpose: NativeRuntimePurpose,
) {
  if (
    !PURPOSES.includes(purpose) ||
    !/^[A-Za-z]:\\/u.test(installRoot) ||
    /[\u0000-\u001f]/u.test(installRoot)
  )
    throw new Error("The installed runtime identity is invalid.");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The native runtime receipt is invalid.");
  const record = value as Record<string, unknown>;
  const names = [
    "schemaVersion",
    "kind",
    "agent",
    "runtimeRoot",
    "runtimeId",
    "manifestSha256",
    "sourceRevision",
    "nodeSha256",
    "nodeVersion",
    "integrity",
    "leaseHeld",
  ];
  if (
    Object.keys(record).some((name) => !names.includes(name)) ||
    Object.keys(record).length !== names.length ||
    record.schemaVersion !== 1 ||
    record.kind !== "native-runtime-session" ||
    record.agent !== purpose ||
    record.leaseHeld !== true ||
    record.integrity !== "installer-sealed-content" ||
    typeof record.runtimeId !== "string" ||
    !HEX64.test(record.runtimeId) ||
    typeof record.manifestSha256 !== "string" ||
    !HEX64.test(record.manifestSha256) ||
    typeof record.sourceRevision !== "string" ||
    !HEX40.test(record.sourceRevision) ||
    typeof record.nodeSha256 !== "string" ||
    !HEX64.test(record.nodeSha256) ||
    typeof record.nodeVersion !== "string" ||
    !NODE_VERSION.test(record.nodeVersion) ||
    typeof record.runtimeRoot !== "string"
  )
    throw new Error("The native runtime receipt is invalid.");
  const installation = path.win32.normalize(installRoot);
  const runtimeRoot = path.win32.join(installation, "runtimes", record.runtimeId);
  if (record.runtimeRoot.toLowerCase() !== runtimeRoot.toLowerCase())
    throw new Error("The runtime lease names a different installed version.");
  const node = path.win32.join(installation, "bin", "node.exe");
  const agentRoot =
    purpose === "inference" ? null : path.win32.join(runtimeRoot, DIRECTORY[purpose]);
  const python =
    purpose === "hermes"
      ? path.win32.join(agentRoot!, "hermes-agent", "venv", "Scripts", "python.exe")
      : purpose === "nemocua" || purpose === "langchain-deepagents-code"
        ? path.win32.join(agentRoot!, "python", "python.exe")
        : null;
  const bash = purpose === "hermes" ? path.win32.join(agentRoot!, "git", "bin", "bash.exe") : null;
  return Object.freeze({
    purpose,
    runtimeRoot,
    runtimeId: record.runtimeId,
    manifestSha256: record.manifestSha256,
    sourceRevision: record.sourceRevision,
    nodeSha256: record.nodeSha256,
    nodeVersion: record.nodeVersion,
    node,
    agentRoot,
    python,
    bash,
    readOnlyRoots: Object.freeze([
      node,
      path.win32.join(runtimeRoot, "workers"),
      ...(agentRoot ? [agentRoot] : []),
    ]),
    integrity: "installer-sealed-content" as const,
    runtimeBytesCopied: 0 as const,
    runtimeFilesHashedAtLaunch: 0 as const,
  });
}

export async function acquireNativeRuntimeSession(
  launcher: string,
  installRoot: string,
  purpose: NativeRuntimePurpose,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  if (!PURPOSES.includes(purpose)) throw new Error("The native runtime purpose is invalid.");
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000)
    throw new Error("The runtime admission deadline is invalid.");
  options.signal?.throwIfAborted();
  const child = spawn(launcher, ["--runtime-session", purpose], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const decoder = new StringDecoder("utf8");
  let text = "",
    count = 0,
    ended = false,
    releasing = false,
    received = false;
  let failure: Error | null = null;
  child.stdin.on("error", () => {});
  child.stderr.resume(); // Native errors are fixed codes; no arbitrary helper output enters UI.
  const closed = new Promise<number>((resolve) =>
    child.once("close", (code) => {
      ended = true;
      resolve(code ?? 1);
    }),
  );
  let rejectReady: (error: Error) => void = () => {};
  let rejectFailure!: (error: Error) => void;
  const cancellation = new AbortController();
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  void failed.catch(() => {});
  const recordFailure = (error: Error) => {
    failure ??= error;
    rejectReady(failure);
    rejectFailure(failure);
    cancellation.abort(failure);
  };
  child.once("error", () => {
    recordFailure(new Error("The installed runtime lease owner could not start."));
  });
  child.once("close", () => {
    if (!releasing)
      recordFailure(new Error("The installed runtime lease owner stopped unexpectedly."));
    else rejectReady(new Error("The runtime admission was interrupted."));
  });
  const settle = async () => {
    if (ended) return await closed;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([
      closed,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 5000);
      }),
    ]);
    clearTimeout(timer);
    if (first !== null) return first;
    child.kill();
    try {
      return await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("The runtime lease owner did not close after its stop request.")),
            5000,
          );
        }),
      ]);
    } catch (error) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborted = () => rejectReady(new Error("The runtime admission was stopped."));
  let selected: ReturnType<typeof validateNativeRuntimeReceipt>;
  try {
    selected = await new Promise((resolve, reject) => {
      rejectReady = reject;
      timer = setTimeout(
        () => reject(new Error("Opening the installed runtime lease timed out.")),
        timeoutMs,
      );
      options.signal?.addEventListener("abort", aborted, { once: true });
      if (options.signal?.aborted) aborted();
      child.stdout.on("data", (chunk: Buffer) => {
        count += chunk.length;
        if (count > 8192 || received) {
          recordFailure(new Error("The runtime receipt exceeds its single-record limit."));
          return;
        }
        text += decoder.write(chunk);
        if (!text.endsWith("\n")) return;
        try {
          const value = validateNativeRuntimeReceipt(JSON.parse(text), installRoot, purpose);
          received = true;
          resolve(value);
        } catch {
          recordFailure(new Error("The native runtime receipt is invalid."));
        }
      });
    });
    if (ended || failure) throw failure ?? new Error("The runtime lease closed during admission.");
  } catch (error) {
    releasing = true;
    child.stdin.end("release\n");
    try {
      await settle();
    } catch (cleanup) {
      throw new Error("Runtime admission failed and its owner did not close.", {
        cause: new AggregateError([error, cleanup]),
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", aborted);
  }
  return {
    ...selected,
    failure: failed,
    signal: cancellation.signal,
    assertHeld() {
      if (failure || ended || releasing)
        throw failure ?? new Error("The installed runtime lease is no longer held.");
    },
    async release() {
      if (releasing) return;
      releasing = true;
      child.stdin.end("release\n");
      const code = await settle();
      if (failure || code !== 0)
        throw failure ?? new Error("The installed runtime lease did not release cleanly.");
    },
  };
}

export type NativeRuntimeSession = Awaited<ReturnType<typeof acquireNativeRuntimeSession>>;

export async function withNativeRuntimeSession<T>(
  launcher: string,
  installRoot: string,
  purpose: NativeRuntimePurpose,
  operation: (runtime: NativeRuntimeSession) => Promise<T>,
  cleanupFailure?: (error: unknown) => void,
): Promise<T> {
  const runtime = await acquireNativeRuntimeSession(launcher, installRoot, purpose);
  return await usingNativeRuntimeSession(runtime, operation, cleanupFailure);
}

export async function usingNativeRuntimeSession<T>(
  runtime: NativeRuntimeSession,
  operation: (runtime: NativeRuntimeSession) => Promise<T>,
  cleanupFailure?: (error: unknown) => void,
): Promise<T> {
  let failed = false;
  try {
    return await operation(runtime);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await runtime.release();
    } catch (error) {
      try {
        cleanupFailure?.(error);
      } catch {
        console.error("The runtime cleanup diagnostic could not be recorded.");
      }
      if (!failed) throw error;
      console.error("The immutable runtime lease also failed to release cleanly.");
    }
  }
}

export function bindNativeRuntimeGuard<T extends { assertHeld(): void }>(
  state: T,
  runtime: NativeRuntimeSession,
): T {
  return {
    ...state,
    assertHeld() {
      state.assertHeld();
      runtime.assertHeld();
    },
  };
}
