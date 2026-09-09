// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

export async function acquireNativeStateSession(launcher: string, purpose: string) {
  return await acquireStateOwner(launcher, purpose, false);
}

export async function acquireNativeStateRemoval(launcher: string, purpose: string) {
  if (purpose === "inference")
    throw new Error("Agent removal cannot remove shared inference state.");
  return await acquireStateOwner(launcher, purpose, true);
}

async function acquireStateOwner(launcher: string, purpose: string, removal: boolean) {
  if (
    !["openclaw", "nemocua", "pi", "hermes", "langchain-deepagents-code", "inference"].includes(
      purpose,
    )
  )
    throw new Error("The native state purpose is invalid.");
  const child = spawn(launcher, [removal ? "--state-remove" : "--state-session", purpose], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let ended = false;
  let releasing = false;
  let failure: Error | null = null;
  child.stdin.on("error", () => {});
  child.stderr.resume();
  const completion = new Promise<number>((resolve) => {
    child.once("error", () => {
      failure = new Error("The private Windows state owner could not start.");
    });
    child.once("close", (code) => {
      ended = true;
      if (!releasing)
        failure ??= new Error("The private Windows state owner stopped unexpectedly.");
      resolve(code ?? 1);
    });
  });
  let text = "";
  let bytes = 0;
  let ready;
  try {
    ready = await new Promise<{ stateRoot: string; created: boolean; removed: boolean }>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Opening private Windows state timed out.")),
          15_000,
        );
        const rejectReady = (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        };
        child.once("error", () => rejectReady(new Error("Opening private Windows state failed.")));
        child.once("close", () =>
          rejectReady(new Error("Private Windows state is unavailable or already in use.")),
        );
        child.stdout.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4096) {
            rejectReady(new Error("The native state receipt exceeds its limit."));
            return;
          }
          text += chunk.toString("utf8");
          if (!text.endsWith("\n")) return;
          try {
            const record = JSON.parse(text);
            const suffix = `-${purpose}`;
            if (
              record.schemaVersion !== 1 ||
              record.kind !== (removal ? "native-state-remove" : "native-state-session") ||
              record.agent !== purpose ||
              record.leaseHeld !== true ||
              (removal
                ? typeof record.removed !== "boolean"
                : typeof record.created !== "boolean") ||
              typeof record.stateRoot !== "string" ||
              !record.stateRoot.endsWith(suffix) ||
              !/^[A-Z]:\\NemoClawState-S-1-(?:\d+-)*\d+-(?:openclaw|nemocua|pi|hermes|langchain-deepagents-code|inference)$/u.test(
                record.stateRoot,
              )
            )
              throw new Error("The private Windows state receipt is invalid.");
            clearTimeout(timeout);
            resolve({
              stateRoot: record.stateRoot,
              created: record.created === true,
              removed: record.removed === true,
            });
          } catch {
            rejectReady(new Error("The private Windows state receipt is invalid."));
          }
        });
      },
    );
  } catch (error) {
    releasing = true;
    child.stdin.end();
    const timeout = setTimeout(() => child.kill(), 5000);
    await completion;
    clearTimeout(timeout);
    throw error;
  }
  return {
    ...ready,
    assertHeld() {
      if (failure || ended || releasing)
        throw failure ?? new Error("The private Windows state lease is closed.");
    },
    async release() {
      if (releasing) return;
      releasing = true;
      child.stdin.end();
      const timeout = setTimeout(() => child.kill(), 15_000);
      const code = await completion;
      clearTimeout(timeout);
      if (failure || code !== 0)
        throw (
          failure ??
          new Error("Windows did not restore private access to the agent's retained state.")
        );
    },
  };
}
