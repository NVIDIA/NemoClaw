// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOrdinaryExecReleaseSleeper,
  releaseAndStopChild,
  waitForChildExit,
} from "../../../test/helpers/privileged-exec-test-helpers";

import {
  createFilePersistedEngineLifecycleStore,
  PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION,
  PERSISTED_ENGINE_STATE_MUTATION_INTENT_SCHEMA_VERSION,
} from "../onboard/runtime-provider/persisted-engine-lifecycle";
import { ShieldsTransitionLockManager } from "../shields/transition-lock";

const roots: string[] = [];
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const tsxLoaderPath = import.meta.resolve("tsx");

function temporaryStateDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-direct-exec-exclusion-"));
  roots.push(root);
  return root;
}

function childEnvironment(stateDir: string): NodeJS.ProcessEnv {
  const isolatedHome = path.join(stateDir, "home");
  fs.mkdirSync(isolatedHome, { recursive: true });
  return {
    ...process.env,
    HOME: isolatedHome,
    NEMOCLAW_TEST_BASE_HOME: isolatedHome,
    NEMOCLAW_TEST_STATE_DIR: stateDir,
    VITEST: "true",
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("privileged direct-execution exclusion", () => {
  it("retries release-marker creation after a transient write failure", () => {
    const stateDir = temporaryStateDir();
    const releaseDir = path.join(stateDir, "late-release-dir");
    const releasePath = path.join(releaseDir, "ordinary.release");
    const ordinaryExecRelease = createOrdinaryExecReleaseSleeper(releasePath, waitBuffer);

    expect(() => ordinaryExecRelease.sleep(1)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(ordinaryExecRelease.wasReleased()).toBe(false);

    fs.mkdirSync(releaseDir);
    expect(() => ordinaryExecRelease.sleep(1)).not.toThrow();
    expect(ordinaryExecRelease.wasReleased()).toBe(true);
    expect(fs.readFileSync(releasePath, "utf8")).toBe("release");
  });

  it("stops the child even when release-marker creation fails", async () => {
    const stateDir = temporaryStateDir();
    const releasePath = path.join(stateDir, "missing", "ordinary.release");
    const child = {
      exitCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;
    vi.mocked(child.kill).mockImplementation(() => {
      Object.defineProperty(child, "exitCode", { configurable: true, value: 137 });
      return true;
    });

    await expect(releaseAndStopChild(child, releasePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it.runIf(process.platform !== "win32")(
    "does not follow a dangling release-marker symlink during child cleanup",
    async () => {
      const stateDir = temporaryStateDir();
      const releasePath = path.join(stateDir, "ordinary.release");
      const targetPath = path.join(stateDir, "symlink-target");
      fs.symlinkSync(targetPath, releasePath);

      await releaseAndStopChild({ exitCode: 0 } as ChildProcess, releasePath);

      expect(fs.lstatSync(releasePath).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(targetPath)).toBe(false);
    },
  );

  it("drains an in-flight exec before provider fencing and rejects the next exec before spawn", async () => {
    const stateDir = temporaryStateDir();
    const readyPath = path.join(stateDir, "ordinary.ready");
    const releasePath = path.join(stateDir, "ordinary.release");
    const lateSpawnPath = path.join(stateDir, "late.spawned");
    const helperPath = path.join(import.meta.dirname, "privileged-exec.ts");
    const environment = childEnvironment(stateDir);
    const holderScript = [
      `const fs=require("node:fs")`,
      `const {withPrivilegedSandboxExecutionLease}=require(${JSON.stringify(helperPath)})`,
      `const [ready,release]=process.argv.slice(1)`,
      `const waitBuffer=new Int32Array(new SharedArrayBuffer(4))`,
      `withPrivilegedSandboxExecutionLease("alpha","ordinary exec in flight",()=>{fs.writeFileSync(ready,"ready");const deadline=Date.now()+10000;while(!fs.existsSync(release)){if(Date.now()>=deadline)throw new Error("release handshake timed out");Atomics.wait(waitBuffer,0,0,10)}})`,
    ].join(";");
    const holder = spawn(
      process.execPath,
      ["--import", tsxLoaderPath, "-e", holderScript, readyPath, releasePath],
      { env: environment, stdio: ["ignore", "ignore", "pipe"] },
    );
    const holderStderr: Buffer[] = [];
    holder.stderr?.on("data", (chunk: Buffer) => holderStderr.push(chunk));

    try {
      await vi.waitFor(
        () => {
          expect(fs.existsSync(readyPath)).toBe(true);
        },
        { interval: 10, timeout: 5_000 },
      );

      const lifecycleStore = createFilePersistedEngineLifecycleStore(stateDir);
      const ordinaryExecRelease = createOrdinaryExecReleaseSleeper(releasePath, waitBuffer);
      const providerLock = new ShieldsTransitionLockManager({
        stateDir,
        sleep: ordinaryExecRelease.sleep,
      });
      const transactionId = "a".repeat(64);
      const serializedPlan = '{"schemaVersion":1,"intent":"protection-transition"}';

      providerLock.withShieldsTransitionLock(
        "alpha",
        "Docker runtime-provider state mutation acquire",
        () => {
          lifecycleStore.recordStateMutationIntent({
            schemaVersion: PERSISTED_ENGINE_STATE_MUTATION_INTENT_SCHEMA_VERSION,
            transactionId,
            serializedPlan,
            planSha256: createHash("sha256").update(serializedPlan, "utf8").digest("hex"),
            projectionSha256: "d".repeat(64),
            nonce: "e".repeat(64),
          });
          lifecycleStore.create({
            schemaVersion: PERSISTED_ENGINE_LIFECYCLE_SCHEMA_VERSION,
            transactionId,
            action: "state-mutation",
            phase: "prepared",
            sandboxName: "alpha",
            resources: [{ role: "target", runtimeId: "runtime-alpha" }],
            runtimeStateSha256: "b".repeat(64),
            engineAuthority: {
              schemaVersion: 1,
              providerId: "docker",
              operation: "sandbox-lifecycle",
              engineId: "docker",
              authorityId: "docker:test",
              bindingSha256: "c".repeat(64),
            },
            resultSha256: null,
          });
          lifecycleStore.authorizeMutation(transactionId);
          const lease = lifecycleStore.acquireMutationExecution(transactionId);
          try {
            lifecycleStore.establishStateMutationFence(lease);
          } finally {
            lifecycleStore.releaseMutationExecution(lease);
          }
        },
        { pollIntervalMs: 10, waitTimeoutMs: 5_000 },
      );

      expect(ordinaryExecRelease.wasReleased()).toBe(true);
      expect(lifecycleStore.load(transactionId)?.phase).toBe("fence-established");
      expect(await waitForChildExit(holder)).toBe(0);
      expect(Buffer.concat(holderStderr).toString("utf8")).toBe("");

      const lateScript = [
        `const fs=require("node:fs")`,
        `const {withPrivilegedSandboxExecutionLease}=require(${JSON.stringify(helperPath)})`,
        `const marker=process.argv[1]`,
        `try{withPrivilegedSandboxExecutionLease("alpha","late ordinary exec",()=>fs.writeFileSync(marker,"spawned"));process.exitCode=2}catch(error){process.stderr.write(error instanceof Error?error.message:String(error))}`,
      ].join(";");
      const late = spawnSync(
        process.execPath,
        ["--import", tsxLoaderPath, "-e", lateScript, lateSpawnPath],
        { encoding: "utf8", env: environment },
      );

      expect(late.status, late.stderr).toBe(0);
      expect(late.stderr).toMatch(/state mutation owns direct-container execution/i);
      expect(fs.existsSync(lateSpawnPath)).toBe(false);
    } finally {
      await releaseAndStopChild(holder, releasePath);
    }
  }, 15_000);
});
