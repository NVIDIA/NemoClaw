// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import { createNativeDiagnosticCapture } from "./native-session-diagnostics.mts";

export async function acquireNativeStateSession(launcher: string, purpose: string) {
  if (!["openclaw", "hermes", "inference"].includes(purpose))
    throw new Error("Select a supported native agent or shared inference session.");
  return await acquireStateOwner(launcher, purpose, "session");
}

export async function acquireNativeStateConfiguration(launcher: string, purpose: string) {
  if (!["openclaw", "hermes"].includes(purpose))
    throw new Error("Select a supported native agent to configure.");
  return await acquireStateOwner(launcher, purpose, "configuration");
}

export async function acquireNativeStateInspection(launcher: string, purpose: string) {
  if (!["openclaw", "hermes"].includes(purpose))
    throw new Error("Select a supported native agent to inspect.");
  const owner = await acquireStateOwner(launcher, purpose, "inspection");
  if (typeof owner.present !== "boolean") {
    await owner.release();
    throw new Error("The private Windows state inspection receipt is invalid.");
  }
  return { ...owner, present: owner.present };
}

export async function acquireNativeStateRemoval(launcher: string, purpose: string) {
  if (purpose === "inference")
    throw new Error("Agent removal cannot remove shared inference state.");
  return await acquireStateOwner(launcher, purpose, "remove");
}

async function acquireStateOwner(
  launcher: string,
  purpose: string,
  mode: "session" | "configuration" | "inspection" | "remove",
) {
  const removal = mode === "remove";
  if (
    !["openclaw", "nemocua", "pi", "hermes", "langchain-deepagents-code", "inference"].includes(
      purpose,
    )
  )
    throw new Error("The native state purpose is invalid.");
  const inspection = mode === "inspection";
  const command =
    mode === "configuration"
      ? "--state-configure"
      : inspection
        ? "--state-inspect"
        : `--state-${mode}`;
  const child = spawn(launcher, [command, purpose], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let ended = false;
  let releasing = false;
  let failure: Error | null = null;
  child.stdin.on("error", () => {});
  const ownerDiagnostics = createNativeDiagnosticCapture(() => []);
  child.stderr.on("data", (chunk: Buffer) => ownerDiagnostics.write(chunk));
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
  const waitForExit = async (milliseconds: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        completion,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const stopOwner = async (graceMilliseconds: number) => {
    child.stdin.end();
    const graceful = await waitForExit(graceMilliseconds);
    if (graceful !== null) return graceful;
    let terminationError: unknown;
    try {
      child.kill();
    } catch (error) {
      terminationError = error;
    }
    const terminated = await waitForExit(5000);
    if (terminated !== null) return terminated;
    failure = new Error(
      "The private Windows state owner exit is unconfirmed; ownership may be retained. Confirm the owner has exited before recovering private state.",
      { cause: terminationError },
    );
    // A retained owner must not keep the failing caller alive through its process or pipes.
    // This does not release the owner's Windows mutex or authorize deleting its private state.
    child.unref();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    throw failure;
  };
  let text = "";
  let bytes = 0;
  let ready;
  try {
    ready = await new Promise<{
      stateRoot: string;
      created: boolean;
      removed: boolean;
      present?: boolean;
    }>((resolve, reject) => {
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
            record.kind !== `native-state-${mode}` ||
            record.agent !== purpose ||
            record.leaseHeld !== true ||
            (inspection
              ? typeof record.present !== "boolean" ||
                Object.keys(record).length !== 6 ||
                Object.keys(record).some(
                  (key) =>
                    ![
                      "schemaVersion",
                      "kind",
                      "agent",
                      "stateRoot",
                      "present",
                      "leaseHeld",
                    ].includes(key),
                )
              : removal
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
            ...(inspection ? { present: record.present } : {}),
          });
        } catch {
          rejectReady(new Error("The private Windows state receipt is invalid."));
        }
      });
    });
  } catch (error) {
    releasing = true;
    try {
      await stopOwner(5000);
    } catch (cleanupError) {
      throw new Error(
        `${error instanceof Error ? error.message : "Opening private Windows state failed."} ${cleanupError instanceof Error ? cleanupError.message : "State-owner cleanup failed."}`,
        { cause: new AggregateError([error, cleanupError]) },
      );
    }
    const detail = ownerDiagnostics.finish().trim();
    if (detail)
      throw new Error(
        `${error instanceof Error ? error.message : "Opening private Windows state failed."} ${detail}`,
        { cause: error },
      );
    throw error;
  }
  let releaseResult: Promise<void> | undefined;
  return {
    ...ready,
    assertHeld() {
      if (failure || ended || releasing)
        throw failure ?? new Error("The private Windows state lease is closed.");
    },
    unrefWithoutRelease() {
      // Failure-only custody handoff to process/job teardown. Keep stdin open:
      // this is not EOF, confirmed owner closure, or permission to remove state.
      const pipes = [child.stdin, child.stdout, child.stderr] as Socket[];
      if (pipes.some((pipe) => typeof pipe.unref !== "function"))
        throw new Error("The retained state owner's process pipes cannot be unreferenced.");
      for (const pipe of pipes) pipe.unref();
      child.unref();
    },
    release() {
      if (releaseResult) return releaseResult;
      releasing = true;
      releaseResult = (async () => {
        const code = await stopOwner(15_000);
        if (failure || code !== 0) {
          const detail = ownerDiagnostics.finish().trim();
          const message =
            failure?.message ??
            "Windows did not restore private access to the agent's retained state.";
          throw new Error(`${message}${detail ? ` ${detail}` : ""}`, {
            cause: failure ?? undefined,
          });
        }
      })();
      return releaseResult;
    },
  };
}
