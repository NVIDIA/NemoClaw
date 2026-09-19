// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  hardwareCatalog,
  captureNative,
  hostCredential,
  installLayout,
  nativeHostEnvironment,
  nativeFreePort,
  ownerRecordPath,
  readOwnerRecord,
  recordSignature,
  writeOwnerRecord,
  controlProof,
  equalProof,
  type NativeOwnerRecord,
} from "./native-inference-host.mts";
import { startNativeRuntimeInferenceSupervisor } from "./native-runtime-inference.mts";
import {
  readPrebuiltNativeModel,
  inspectPrebuiltNativeModel,
} from "./native-prebuilt-inference.mts";
import { withNativeRuntimeSession, type NativeRuntimeSession } from "./native-runtime.mts";
import {
  NATIVE_EXPRESS,
  nativeServerArguments,
  cudaDeviceFromListing,
  requireFullCudaOffload,
  type ProgressSink,
} from "./native-inference-manifest.mts";
import { acquireNativeStateSession } from "./native-state.mts";
import { responseChunks } from "./native-inference-download.mts";
import { createNativeInferenceGuard } from "./native-inference-guard.mts";

export type NativeInferenceOptions = {
  installRoot: string;
  signal?: AbortSignal;
  onProgress?: ProgressSink;
};
export type NativeInferenceConnection = {
  endpoint: string;
  model: string;
  localModel: string;
  credential: string;
};
const quiet: ProgressSink = () => undefined;

async function responseJson(response: Response, maximum = 512 * 1024): Promise<unknown> {
  if (!response.body) throw new Error("The local inference response is empty.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of responseChunks(response.body)) {
    bytes += chunk.length;
    if (bytes > maximum) throw new Error("The local inference response exceeded its limit.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function existingOwner(installRoot: string, signal?: AbortSignal) {
  const layout = installLayout(installRoot);
  if (!fs.existsSync(ownerRecordPath())) return null;
  const credential = await hostCredential(layout.launcher, "read");
  const record = readOwnerRecord(credential);
  if (!record || record.status === "error") return null;
  return verifyNativeOwnerListener(record, credential, signal);
}

export async function verifyNativeOwnerListener(
  record: NativeOwnerRecord,
  credential: string,
  signal?: AbortSignal,
) {
  if (
    !Number.isInteger(record.port) ||
    record.port < 1 ||
    record.port > 65_535 ||
    !equalProof(record.signature, recordSignature(record, credential))
  )
    throw new Error("The managed inference discovery record could not be authenticated.");
  const nonce = randomBytes(32).toString("hex");
  // Intentional host-only IPC: the authenticated record selects only a bounded
  // integer port on literal 127.0.0.1. Only a fresh nonce is sent, never the key or
  // other file contents; redirects fail and the response is bounded to 16 KiB/2s.
  // Credentials are returned only after the listener proves key possession.
  // codeql[js/file-access-to-http]: authenticated loopback discovery challenge, no secret request data.
  const response = await fetch(`http://127.0.0.1:${record.port}/identity?nonce=${nonce}`, {
    redirect: "error",
    signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(2000)]),
  });
  const identity = (await responseJson(response, 16 * 1024)) as {
    proof?: string;
    record?: NativeOwnerRecord;
  } | null;
  if (
    response.status !== 200 ||
    !identity?.record ||
    identity.record.instance !== record.instance ||
    identity.record.port !== record.port ||
    !equalProof(identity.proof, controlProof(credential, "identity", record.instance, nonce)) ||
    !equalProof(identity.record.signature, recordSignature(identity.record, credential))
  )
    throw new Error("The current local inference listener could not prove its ownership.");
  return { record: identity.record, credential };
}

function connection(owner: {
  record: NativeOwnerRecord;
  credential: string;
}): NativeInferenceConnection {
  if (
    owner.record.status !== "ready" ||
    !owner.record.proof ||
    owner.record.proof.offloadedLayers < 1 ||
    owner.record.proof.offloadedLayers !== owner.record.proof.totalLayers ||
    !/^CUDA\d+$/u.test(owner.record.proof.cudaDevice)
  )
    throw new Error("The local model has not completed native CUDA readiness.");
  return {
    endpoint: `http://127.0.0.1:${owner.record.port}/v1`,
    model: NATIVE_EXPRESS.model,
    localModel: NATIVE_EXPRESS.id,
    credential: owner.credential,
  };
}

export async function nativeInferenceCatalog(options: NativeInferenceOptions) {
  const catalog = await hardwareCatalog(options.installRoot, options.signal);
  if (process.platform !== "win32" || process.arch !== "arm64") return catalog;
  try {
    const owner = await existingOwner(options.installRoot, options.signal);
    if (owner?.record.status === "ready") {
      connection(owner);
      return { ...catalog, eligible: true, reasons: [], ready: true };
    }
  } catch {
    options.signal?.throwIfAborted();
  }
  return { ...catalog, ready: false };
}

export async function installNativeInference(options: NativeInferenceOptions) {
  options.signal?.throwIfAborted();
  const layout = installLayout(options.installRoot);
  const prebuilt = await inspectPrebuiltNativeModel(options.installRoot, layout.launcher);
  return { schemaVersion: 1, event: "available", localModel: NATIVE_EXPRESS.id, prebuilt };
}

export async function ensureNativeInference(
  options: NativeInferenceOptions,
): Promise<NativeInferenceConnection> {
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(NATIVE_EXPRESS.readinessTimeoutMs),
  ]);
  const layout = installLayout(options.installRoot);
  const progress = options.onProgress ?? quiet;
  let supervisor: Awaited<ReturnType<typeof startNativeRuntimeInferenceSupervisor>> | undefined;
  let supervisorEnded = false;
  let ownerInstance: string | undefined;
  let ownedInstance: string | undefined;
  let ready = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const existing = await existingOwner(options.installRoot, signal).catch(() => null);
      if (existing) {
        ownerInstance = existing.record.instance;
        if (supervisor?.pid === existing.record.launcherPid)
          ownedInstance = existing.record.instance;
        if (existing.record.progress) progress(existing.record.progress);
        if (existing.record.status === "ready") {
          // Only a newly started service has provisional guardian ownership.
          // A reused authenticated service never receives this start/commit path.
          if (supervisor) {
            if (supervisor.pid === existing.record.launcherPid) await supervisor.commit();
            else await supervisor.cancel(); // A different authenticated owner won startup; preserve it.
          }
          ready = true;
          return connection(existing);
        }
        if (existing.record.status === "error")
          throw new Error(existing.record.failure ?? "The local model could not start.");
      } else if (!supervisor && !ownerInstance) {
        supervisor = await startNativeRuntimeInferenceSupervisor(signal);
      }
      if (supervisor) {
        await supervisor.refresh();
        supervisorEnded = supervisor.ended;
      }
      if (!existing && (supervisorEnded || (!supervisor && ownerInstance))) {
        let detail = "The native model supervisor stopped before readiness.";
        try {
          const key = await hostCredential(layout.launcher, "read");
          detail = readOwnerRecord(key)?.failure ?? detail;
        } catch {
          /* bounded host-owned message below */
        }
        throw new Error(detail);
      }
      progress({
        schemaVersion: 1,
        event: "progress",
        phase: "loading",
        message: "Waiting for the local model to finish its on-device checks",
      });
      await sleep(500, undefined, { signal });
    }
  } finally {
    if (!ready && supervisor) {
      // Only cancel the supervisor started by this call, never a ready shared
      // server that another agent already owned when the operation began.
      if (ownedInstance && !supervisorEnded)
        await stopNativeInference({ ...options, signal: undefined }, ownedInstance).catch(
          () => undefined,
        );
      try {
        await supervisor.cancel();
      } catch {
        console.error("The newly started native inference owner did not confirm cancellation.");
      }
    }
  }
}

export async function stopNativeInference(
  options: NativeInferenceOptions,
  expectedInstance?: string,
) {
  const owner = await existingOwner(options.installRoot, options.signal).catch(() => null);
  if (!owner) return { schemaVersion: 1, event: "stopped", alreadyStopped: true };
  if (expectedInstance && owner.record.instance !== expectedInstance)
    return { schemaVersion: 1, event: "stopped", alreadyStopped: true };
  const nonce = randomBytes(32).toString("hex");
  const response = await fetch(`http://127.0.0.1:${owner.record.port}/stop`, {
    method: "POST",
    redirect: "error",
    headers: {
      "x-nemoclaw-nonce": nonce,
      "x-nemoclaw-proof": controlProof(owner.credential, "stop", owner.record.instance, nonce),
    },
    signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 202) throw new Error("The owned local model did not accept shutdown.");
  await response.body?.cancel();
  const deadline = Date.now() + NATIVE_EXPRESS.shutdownTimeoutMs;
  while (Date.now() < deadline) {
    if (!(await existingOwner(options.installRoot).catch(() => null)))
      return { schemaVersion: 1, event: "stopped", alreadyStopped: false };
    await sleep(200);
  }
  throw new Error("The local model did not finish shutdown within its limit.");
}

type NativeInferenceCleanup = {
  closeListener(): Promise<void>;
  stopServer(): Promise<void>;
  serverStopped(): boolean;
  removeRuntime(): Promise<void>;
  removeRecord(): Promise<void>;
  deleteCredential(): Promise<void>;
  releaseState(): Promise<void>;
};

async function collectNativeInferenceCleanup(
  failure: Error | undefined,
  actions: Array<() => Promise<void>>,
): Promise<Error | undefined> {
  const errors: Error[] = failure ? [failure] : [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error("Native inference cleanup failed."));
    }
  }
  if (errors.length > 1)
    return new AggregateError(errors, errors.map((error) => error.message).join(" "));
  return errors[0];
}

export async function finishNativeInferencePreparation(
  failure: Error | undefined,
  cleanup: Pick<NativeInferenceCleanup, "removeRuntime" | "releaseState">,
): Promise<Error | undefined> {
  return collectNativeInferenceCleanup(failure, [
    () => cleanup.removeRuntime(),
    () => cleanup.releaseState(),
  ]);
}

export async function finishNativeInferenceCleanup(
  failure: Error | undefined,
  cleanup: NativeInferenceCleanup,
): Promise<Error | undefined> {
  return collectNativeInferenceCleanup(failure, [
    () => cleanup.closeListener(),
    () => cleanup.stopServer(),
    () => cleanup.removeRuntime(),
    // A failed startup retains its authenticated diagnostic record and key. A
    // normal stop attempts both removals even if earlier cleanup failed.
    ...(!failure ? [() => cleanup.removeRecord(), () => cleanup.deleteCredential()] : []),
    async () => {
      if (!cleanup.serverStopped())
        throw new Error(
          "The native state lease is retained until the process owner terminates the live CUDA server.",
        );
      await cleanup.releaseState();
    },
  ]);
}

export async function waitForNativeInferenceShutdown(
  completion: Promise<void>,
  timeoutMs = NATIVE_EXPRESS.shutdownTimeoutMs,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      completion,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The native CUDA server did not stop.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function serveNativeInference(options: NativeInferenceOptions): Promise<void> {
  const layout = installLayout(options.installRoot);
  return await withNativeRuntimeSession(
    layout.launcher,
    options.installRoot,
    "inference",
    (lease) => servePrebuiltNativeInference(options, lease),
  );
}

async function servePrebuiltNativeInference(
  options: NativeInferenceOptions,
  runtimeLease: NativeRuntimeSession,
): Promise<void> {
  options.signal?.throwIfAborted();
  const layout = installLayout(options.installRoot);
  const state = await acquireNativeStateSession(layout.launcher, "inference");
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const signal = controller.signal;
  const credential = randomBytes(32).toString("base64url");
  const upstreamCredential = randomBytes(32).toString("base64url");
  const record: NativeOwnerRecord = {
    schemaVersion: 1,
    instance: randomUUID(),
    localModel: NATIVE_EXPRESS.id,
    model: NATIVE_EXPRESS.model,
    port: 1,
    pid: process.pid,
    launcherPid: process.ppid,
    status: "starting",
  };
  let prepared:
    | (ReturnType<typeof readPrebuiltNativeModel> & {
        environment: NodeJS.ProcessEnv;
        device: string;
      })
    | undefined;
  let serverProcess: ChildProcess | undefined;
  let serverClosed: Promise<void> | undefined;
  let upstreamPort = 0;
  let startupLog = "";
  let failure: Error | undefined;
  let closing = false;
  const guard = createNativeInferenceGuard({
    record,
    credential,
    upstreamCredential,
    signal,
    upstreamPort: () => upstreamPort,
    onStop: () => controller.abort(),
    assertHeld: () => state.assertHeld(),
  });
  const onProgress: ProgressSink = (event) => {
    state.assertHeld();
    record.progress = event;
    writeOwnerRecord(record, credential);
    options.onProgress?.(event);
  };
  try {
    await hostCredential(layout.launcher, "write", credential);
    await new Promise<void>((resolve, reject) => {
      guard.once("error", reject);
      guard.listen(0, "127.0.0.1", resolve);
    });
    record.port = (guard.address() as { port: number }).port;
    writeOwnerRecord(record, credential);
    const pack = readPrebuiltNativeModel(runtimeLease);
    const catalog = await hardwareCatalog(options.installRoot, signal, { prebuilt: true });
    if (!catalog.eligible) throw new Error(catalog.reasons.join(" "));
    const environment = nativeHostEnvironment({
      PATH: `${pack.runtimeRoot};${path.join(layout.systemRoot, "System32")};${layout.systemRoot}`,
    });
    const device = cudaDeviceFromListing(
      await captureNative(pack.executable, ["--list-devices"], {
        signal,
        timeoutMs: 60_000,
        environment,
        cwd: pack.runtimeRoot,
      }),
    );
    prepared = { ...pack, environment, device };
    upstreamPort = await nativeFreePort();
    onProgress({
      schemaVersion: 1,
      event: "progress",
      phase: "loading",
      message: "Loading Qwen 3.6 on the native CUDA GPU",
    });
    serverProcess = spawn(
      prepared.executable,
      nativeServerArguments(prepared.modelPath, upstreamPort, prepared.device),
      {
        env: { ...prepared.environment, LLAMA_API_KEY: upstreamCredential },
        cwd: prepared.runtimeRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    serverClosed = new Promise<void>((resolve) => {
      serverProcess!.once("error", () => {
        failure = new Error("The native CUDA model server could not start.");
        controller.abort();
      });
      serverProcess!.once("close", () => {
        if (!closing && !signal.aborted)
          failure = new Error("The native CUDA model server stopped unexpectedly.");
        controller.abort();
        resolve();
      });
    });
    const log = (chunk: Buffer) => {
      if (record.status === "ready") return;
      if (startupLog.length < 4 * 1024 * 1024)
        startupLog += chunk.toString("utf8").slice(0, 4 * 1024 * 1024 - startupLog.length);
    };
    serverProcess.stdout!.on("data", log);
    serverProcess.stderr!.on("data", log);
    const readinessSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(NATIVE_EXPRESS.readinessTimeoutMs),
    ]);
    const upstream = async (route: string, init?: RequestInit) => {
      const response = await fetch(`http://127.0.0.1:${upstreamPort}${route}`, {
        ...init,
        redirect: "error",
        headers: {
          authorization: `Bearer ${upstreamCredential}`,
          "content-type": "application/json",
          ...init?.headers,
        },
        signal: AbortSignal.any([readinessSignal, AbortSignal.timeout(30_000)]),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error("The native model has not completed readiness.");
      }
      return response;
    };
    for (;;) {
      readinessSignal.throwIfAborted();
      try {
        const health = (await responseJson(await upstream("/health"))) as { status?: string };
        if (health.status === "ok") break;
      } catch {
        readinessSignal.throwIfAborted();
      }
      await sleep(500, undefined, { signal: readinessSignal });
    }
    onProgress({
      schemaVersion: 1,
      event: "progress",
      phase: "probing",
      message: "Verifying full CUDA offload, model identity, and a real model response",
    });
    const offload = requireFullCudaOffload(startupLog);
    const models = (await responseJson(await upstream("/v1/models"))) as {
      data?: Array<{ id?: string }>;
    };
    if (!models.data?.some((model) => model.id === NATIVE_EXPRESS.model))
      throw new Error("The native server loaded an unexpected model.");
    const props = (await responseJson(await upstream("/props"))) as {
      total_slots?: number;
      default_generation_settings?: { n_ctx?: number };
      model_path?: string;
    };
    if (
      props.total_slots !== 1 ||
      props.default_generation_settings?.n_ctx !== NATIVE_EXPRESS.contextSize ||
      props.model_path?.replaceAll("/", "\\").toLowerCase() !==
        prepared.modelPath.replaceAll("/", "\\").toLowerCase()
    )
      throw new Error("The native model properties do not match the selected recipe.");
    const rejected = await fetch(`http://127.0.0.1:${upstreamPort}/v1/models`, {
      headers: { authorization: "Bearer invalid-native-qualification-key" },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    await rejected.body?.cancel();
    if (rejected.status !== 401)
      throw new Error("The native model server did not reject an incorrect credential.");
    const completion = (await responseJson(
      await upstream("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: NATIVE_EXPRESS.model,
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 32,
          temperature: 0,
          reasoning_effort: "none",
          stream: false,
        }),
      }),
    )) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { completion_tokens?: number };
    };
    if (
      !completion.choices?.[0]?.message?.content?.trim() ||
      (completion.usage?.completion_tokens ?? 0) < 1
    )
      throw new Error("The native CUDA model did not produce a readiness response.");
    const metrics = await upstream("/metrics");
    if (!metrics.body) throw new Error("The native model metrics are unavailable.");
    let metricText = "";
    for await (const chunk of responseChunks(metrics.body)) {
      if (metricText.length + chunk.byteLength > 256 * 1024)
        throw new Error("The native model metrics exceeded their bound.");
      metricText += Buffer.from(chunk).toString("utf8");
    }
    if (!metricText.includes("llamacpp:"))
      throw new Error("The native model metrics are unavailable.");
    state.assertHeld();
    record.proof = { ...offload, cudaDevice: prepared.device };
    record.status = "ready";
    delete record.progress;
    writeOwnerRecord(record, credential);
    startupLog = "";
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    if (failure) throw failure;
  } catch (error) {
    if ((!options.signal?.aborted && !signal.aborted) || failure) {
      failure ??= error instanceof Error ? error : new Error("The native model failed readiness.");
      record.status = "error";
      record.failure = failure.message.slice(0, 1024);
      delete record.progress;
      try {
        writeOwnerRecord(record, credential);
      } catch (error) {
        const diagnosticFailure =
          error instanceof Error
            ? error
            : new Error("The native model failure record could not be saved.");
        failure = new AggregateError(
          [failure, diagnosticFailure],
          `${failure.message} ${diagnosticFailure.message}`,
        );
      }
    }
  } finally {
    closing = true;
    controller.abort();
    options.signal?.removeEventListener("abort", abort);
    failure = await finishNativeInferenceCleanup(failure, {
      async closeListener() {
        guard.closeAllConnections();
        await new Promise<void>((resolve) => guard.close(() => resolve()));
      },
      async stopServer() {
        if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null)
          serverProcess.kill("SIGKILL");
        if (serverClosed) await waitForNativeInferenceShutdown(serverClosed);
      },
      serverStopped: () =>
        !serverProcess || serverProcess.exitCode !== null || serverProcess.signalCode !== null,
      async removeRuntime() {
        // Prebuilt runtime bytes belong to the distribution, never this session.
        runtimeLease.assertHeld();
      },
      async removeRecord() {
        try {
          await fs.promises.unlink(ownerRecordPath());
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      },
      deleteCredential: () => hostCredential(layout.launcher, "delete").then(() => undefined),
      releaseState: () => state.release(),
    });
  }
  if (failure) throw failure;
}
