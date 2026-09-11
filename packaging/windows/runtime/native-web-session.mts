// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createNativeBrowserOpener } from "./native-runtime-browser.mts";
import { join, resolve } from "node:path";
import { cp, lstat, readdir } from "node:fs/promises";
import type { Writable } from "node:stream";
import type { NativeFailurePresentation } from "./native-session-diagnostics.mts";

export type NativeProgressStage =
  | "inference"
  | "runtime"
  | "gateway"
  | "sandbox"
  | "bootstrap"
  | "dashboard"
  | "browser"
  | "running"
  | "cleanup";
export type NativeProgressCounts = {
  completed: number;
  total: number;
  unit: "bytes" | "files" | "items";
};
const PROGRESS_STAGES: readonly NativeProgressStage[] = [
  "inference",
  "runtime",
  "gateway",
  "sandbox",
  "bootstrap",
  "dashboard",
  "browser",
  "running",
  "cleanup",
];

/** Send only bounded progress data, retaining at most one coalesced update. */
export function createNativeProgressWriter(stream: Writable) {
  let pending:
    | ({ kind: "progress"; stage: NativeProgressStage } & Partial<NativeProgressCounts>)
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  let lastSent = 0;
  let lastStage: NativeProgressStage | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (ended || !pending || stream.destroyed || stream.writableEnded || stream.writableNeedDrain)
      return;
    const record = pending;
    pending = undefined;
    lastSent = performance.now();
    stream.write(JSON.stringify(record) + "\n");
  };
  stream.on("drain", flush);
  return {
    progress(stage: NativeProgressStage, counts?: NativeProgressCounts) {
      if (ended || !PROGRESS_STAGES.includes(stage)) return;
      const valid =
        counts &&
        Number.isSafeInteger(counts.completed) &&
        Number.isSafeInteger(counts.total) &&
        counts.completed >= 0 &&
        counts.total > 0 &&
        counts.completed <= counts.total &&
        ["bytes", "files", "items"].includes(counts.unit);
      pending = {
        kind: "progress",
        stage,
        ...(valid
          ? {
              completed: counts.completed,
              total: counts.total,
              unit: counts.unit,
            }
          : {}),
      };
      const changed = stage !== lastStage;
      lastStage = stage;
      if (changed) flush();
      else if (timer === undefined)
        timer = setTimeout(flush, Math.max(0, 250 - (performance.now() - lastSent)));
    },
    clear() {
      pending = undefined;
      clearTimeout(timer);
      timer = undefined;
    },
    close() {
      ended = true;
      pending = undefined;
      clearTimeout(timer);
      timer = undefined;
      stream.off("drain", flush);
    },
  };
}

type CopyTarget = { source: string; destination: string };
type CopyOptions = {
  signal?: AbortSignal;
  onProgress?: (counts?: NativeProgressCounts) => void;
  onTargetStart?: (index: number) => void;
};

/** Stage installed files without blocking Stop; the caller owns partial-copy cleanup. */
export async function copyNativeRuntime(targets: readonly CopyTarget[], options: CopyOptions = {}) {
  let total = 0;
  let completed = 0;
  options.signal?.throwIfAborted();
  options.onProgress?.();

  const visit = async (target: CopyTarget, copying: boolean): Promise<void> => {
    options.signal?.throwIfAborted();
    const entry = await lstat(target.source);
    options.signal?.throwIfAborted();
    if (entry.isDirectory()) {
      if (copying) {
        // Let cp retain its source/destination identity, alias, directory-mode
        // and symlink checks. Copy just this directory; children are awaited
        // individually so progress means a completed operation, not a queue.
        await cp(target.source, target.destination, {
          recursive: true,
          filter: (source) => source === target.source,
        });
      }
      for (const name of await readdir(target.source)) {
        await visit(
          { source: join(target.source, name), destination: join(target.destination, name) },
          copying,
        );
      }
      return;
    }
    if (!copying) {
      total++;
      if (!Number.isSafeInteger(total))
        throw new Error("The native runtime file count is invalid.");
      return;
    }
    await cp(target.source, target.destination);
    options.signal?.throwIfAborted();
    completed++;
    if (completed > total) throw new Error("The installed native runtime changed during staging.");
    options.onProgress?.({ completed, total, unit: "files" });
  };

  const normalized = targets.map(({ source, destination }) => ({
    source: resolve(source),
    destination: resolve(destination),
  }));
  for (const target of normalized) await visit(target, false);
  if (total > 0) options.onProgress?.({ completed, total, unit: "files" });
  for (const [index, target] of normalized.entries()) {
    options.signal?.throwIfAborted();
    options.onTargetStart?.(index);
    await visit(target, true);
  }
  options.signal?.throwIfAborted();
  if (completed !== total) throw new Error("The installed native runtime changed during staging.");
  return { completed, total };
}

function validateAddress(url: string) {
  const address = new URL(url);
  if (
    address.protocol !== "http:" ||
    address.hostname !== "127.0.0.1" ||
    address.username ||
    address.password ||
    url.length > 1600
  )
    throw new Error("The native web session address is invalid.");
}

export async function openNativeWebSession(
  installRoot: string,
  agent: "openclaw" | "hermes",
  url?: string,
  options: { qualification?: boolean } = {},
) {
  if (url !== undefined) validateAddress(url);
  const child = spawn(
    join(installRoot, "native-ui", "NemoClaw.Bootstrapper.exe"),
    ["--web-session", "--agent", agent],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stderr.resume();
  child.stdin.on("error", () => {});
  const progressWriter = createNativeProgressWriter(child.stdin);
  let ended = false;
  let completing = false;
  let stopRequested = false;
  let capabilitiesSent = false;
  const cancellation = new AbortController();
  const closed = new Promise<number>((resolve) =>
    child.once("close", (code) => {
      ended = true;
      progressWriter.close();
      resolve(code ?? 1);
    }),
  );
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  let ready!: () => void;
  let fail!: (error: Error) => void;
  const readiness = new Promise<void>((resolve, reject) => {
    ready = resolve;
    fail = reject;
  });
  let bytes = 0;
  let pending = "";
  let sawReady = false;
  let failure: Error | undefined;
  let completion: Promise<void> | undefined;
  let browser: Promise<Awaited<ReturnType<typeof createNativeBrowserOpener>>> | undefined;
  let browserOpening: Promise<void> | undefined;
  let browserAddress = url;
  let openRequests = 0;
  const closeBrowser = async () => {
    if (browserOpening) await browserOpening;
    if (browser)
      await browser.then(
        (owner) => owner.close(),
        () => {},
      );
  };
  const reject = () => {
    failure ??= new Error("The native web session control stopped unexpectedly.");
    fail(failure);
    stop();
    cancellation.abort(failure);
  };
  child.once("error", reject);
  child.once("close", () => {
    if (!completing) reject();
    else stop();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 4096) {
      reject();
      child.kill();
      return;
    }
    pending += chunk.toString("utf8");
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        const record = JSON.parse(line);
        if (record.kind === "ready" && !sawReady) {
          sawReady = true;
          ready();
        } else if (
          record.kind === "open" &&
          Object.keys(record).length === 1 &&
          sawReady &&
          !stopRequested &&
          !completing &&
          !browserOpening &&
          browserAddress !== undefined &&
          ++openRequests <= 64
        ) {
          browser ??= createNativeBrowserOpener(browserAddress);
          browserOpening = browser
            .then(async (owner) => {
              await owner.open();
              if (!ended && !completing && !stopRequested)
                child.stdin.write('{"kind":"browser-opened"}\n');
            })
            .catch(() => {
              if (!ended && !completing && !stopRequested)
                child.stdin.write('{"kind":"browser-failed"}\n');
            })
            .finally(() => {
              browserOpening = undefined;
            });
        } else if (record.kind === "stop" && sawReady) {
          stopRequested = true;
          cancellation.abort(new Error("The native Web UI session was stopped."));
          stop();
        } else reject();
      } catch {
        reject();
      }
    }
  });
  const timeout = setTimeout(reject, 15_000);
  child.stdin.write(
    JSON.stringify({
      schemaVersion: 1,
      agent,
      url,
      qualification: options.qualification === true,
    }) + "\n",
  );
  try {
    await readiness;
  } catch (error) {
    child.stdin.end();
    child.kill();
    await closed;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  return {
    // Resolve on Stop or unexpected UI exit; the owner must always clean up.
    stopped,
    signal: cancellation.signal,
    assertRunning() {
      if (failure || ended || stopRequested)
        throw new Error("The native Web UI session was stopped.");
    },
    ready(address: string) {
      if (failure || ended || stopRequested)
        throw new Error("The native Web UI session was stopped.");
      validateAddress(address);
      browserAddress = address;
      progressWriter.clear();
      child.stdin.write(JSON.stringify({ kind: "ready", url: address }) + "\n");
    },
    progress(stage: NativeProgressStage, counts?: NativeProgressCounts) {
      if (!ended && !completing) progressWriter.progress(stage, counts);
    },
    capabilities(search: "available" | "unconfigured" | "unavailable") {
      if (
        ended ||
        completing ||
        capabilitiesSent ||
        !["available", "unconfigured", "unavailable"].includes(search)
      )
        return;
      capabilitiesSent = true;
      child.stdin.write(JSON.stringify({ kind: "capabilities", search }) + "\n");
    },
    async complete(cleanupSucceeded: boolean, detail?: NativeFailurePresentation) {
      if (completion) return await completion;
      completion = (async () => {
        completing = true;
        progressWriter.close();
        let browserFailure: unknown;
        try {
          await closeBrowser();
        } catch (error) {
          browserFailure = error;
        }
        if (!ended)
          child.stdin.end(
            JSON.stringify({ kind: cleanupSucceeded ? "stopped" : "failed", ...detail }) + "\n",
          );
        // A startup error is a visible notice after backend cleanup. Let the user
        // read/open its diagnostic file and close the window deliberately.
        const timer = setTimeout(() => child.kill(), cleanupSucceeded ? 5000 : 24 * 60 * 60_000);
        try {
          await closed;
        } finally {
          clearTimeout(timer);
        }
        if (failure) throw failure;
        if (browserFailure) throw browserFailure;
      })();
      return await completion;
    },
  };
}
