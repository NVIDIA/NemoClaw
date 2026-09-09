// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import {
  NATIVE_EXPRESS,
  nativeEligibility,
  type NativeHardware,
  type NativeInferenceProgress,
} from "./native-inference-manifest.mts";
import { readOpenedRegularFile } from "./native-security.mts";

export function nativeHostEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const allowed = new Set([
    "localappdata",
    "systemroot",
    "systemdrive",
    "temp",
    "tmp",
    "windir",
    "comspec",
    "number_of_processors",
    "processor_architecture",
    "os",
    "pathext",
  ]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (allowed.has(key.toLowerCase()) && value !== undefined) environment[key] = value;
  const systemRoot = process.env.SystemRoot;
  if (systemRoot) environment.PATH = `${path.join(systemRoot, "System32")};${systemRoot}`;
  return { ...environment, ...extra };
}

export async function nativeFreePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

// Domain-separated from all user-entered provider credentials. Only this host
// owner may bind the key to its authenticated, managed loopback endpoint.
const HOST_INFERENCE_BINDING = "d35e8fa30d84e4b577db76cd09f2ac7da61a95def9e4379eb339f289a4139cc3";

export type NativeOwnerRecord = {
  schemaVersion: 1;
  instance: string;
  localModel: string;
  model: string;
  port: number;
  pid: number;
  launcherPid: number;
  status: "starting" | "ready" | "error";
  progress?: NativeInferenceProgress;
  failure?: string;
  proof?: { offloadedLayers: number; totalLayers: number; cudaDevice: string };
  signature?: string;
};

export function installLayout(installRoot: string) {
  if (process.platform !== "win32" || process.arch !== "arm64")
    throw new Error("Native Windows ARM64 is required for on-device Express.");
  const root = path.resolve(installRoot);
  const launcher = path.join(root, "bin", "NemoClaw.exe");
  const python = path.join(root, "python", "python.exe");
  for (const file of [launcher, python]) {
    if (!fs.lstatSync(file).isFile())
      throw new Error("The installed native inference helpers are incomplete.");
  }
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !/^[A-Za-z]:\\/u.test(systemRoot) || !fs.statSync(systemRoot).isDirectory())
    throw new Error("The Windows system directory is unavailable.");
  return { root, launcher, python, systemRoot };
}

export async function captureNative(
  executable: string,
  arguments_: string[],
  options: {
    signal?: AbortSignal;
    input?: Buffer;
    timeoutMs?: number;
    maxBytes?: number;
    environment?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      env: options.environment ?? nativeHostEnvironment(),
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = Buffer.alloc(0);
    let bytes = 0;
    let failure: Error | undefined;
    const kill = (message: string) => {
      failure ??= new Error(message);
      child.kill();
    };
    const abort = () => kill("The native inference operation was cancelled.");
    const timer = setTimeout(
      () => kill("The native inference helper timed out."),
      options.timeoutMs ?? 15_000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 1024 * 1024)) {
        kill("The native inference helper exceeded its output limit.");
        return;
      }
      output = Buffer.concat([output, chunk]);
    });
    // Diagnostics may include launch arguments and paths. Capture only a bound,
    // and return a host-owned error message rather than forwarding raw output.
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 1024 * 1024))
        kill("The native inference helper exceeded its output limit.");
    });
    child.once("error", () => {
      failure = new Error("The native inference helper could not start.");
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure || code !== 0)
        reject(
          failure ??
            new Error(
              "The native inference helper failed. Check the Windows GPU driver and installed package.",
            ),
        );
      else resolve(output.toString("utf8"));
      output.fill(0);
    });
    child.stdin.end(options.input);
  });
}

export async function hostCredential(
  launcher: string,
  operation: "read" | "write" | "delete",
  value?: string,
): Promise<string> {
  const input = value === undefined ? undefined : Buffer.from(value, "utf8");
  try {
    const output = await captureNative(
      launcher,
      [`--credential-${operation}`, "local", "--binding", HOST_INFERENCE_BINDING],
      { input, maxBytes: 4096 },
    );
    if (operation === "read" && !/^[A-Za-z0-9_-]{43}$/u.test(output))
      throw new Error("The managed local inference credential is unavailable.");
    return output;
  } finally {
    input?.fill(0);
  }
}

export function ownerRecordPath(create = false): string {
  const local = process.env.LOCALAPPDATA;
  if (!local || !/^[A-Za-z]:\\/u.test(local))
    throw new Error("Private Windows application data is unavailable.");
  let current = path.resolve(local);
  for (const segment of ["NVIDIA", "NemoClaw", "native-inference"]) {
    if (fs.lstatSync(current).isSymbolicLink())
      throw new Error("The inference discovery directory cannot be a reparse point.");
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      if (!create) return path.join(local, "NVIDIA", "NemoClaw", "native-inference", "owner.json");
      fs.mkdirSync(current);
    }
  }
  if (fs.lstatSync(current).isSymbolicLink())
    throw new Error("The inference discovery directory cannot be a reparse point.");
  return path.join(current, "owner.json");
}

function unsignedRecord(record: NativeOwnerRecord): string {
  const { signature: _signature, ...data } = record;
  return JSON.stringify(data);
}

export function recordSignature(record: NativeOwnerRecord, credential: string): string {
  return createHmac("sha256", credential).update(unsignedRecord(record)).digest("hex");
}

export function writeOwnerRecord(record: NativeOwnerRecord, credential: string): void {
  const file = ownerRecordPath(true);
  const temporary = `${file}.${record.instance}.tmp`;
  fs.writeFileSync(
    temporary,
    JSON.stringify({ ...record, signature: recordSignature(record, credential) }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  fs.renameSync(temporary, file);
}

export function readOwnerRecord(credential: string): NativeOwnerRecord | null {
  const raw = readOpenedRegularFile(ownerRecordPath(), { encoding: "utf8", maxBytes: 16 * 1024 });
  if (raw === null) return null;
  const record = JSON.parse(raw) as NativeOwnerRecord;
  if (
    record.schemaVersion !== 1 ||
    record.localModel !== NATIVE_EXPRESS.id ||
    record.model !== NATIVE_EXPRESS.model ||
    !Number.isInteger(record.port) ||
    record.port < 1 ||
    record.port > 65_535 ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    !Number.isSafeInteger(record.launcherPid) ||
    record.launcherPid < 1 ||
    !/^[a-f0-9-]{36}$/u.test(record.instance) ||
    !/^[a-f0-9]{64}$/u.test(record.signature ?? "") ||
    !["starting", "ready", "error"].includes(record.status)
  )
    throw new Error("The managed inference discovery record is invalid.");
  if (
    !timingSafeEqual(
      Buffer.from(record.signature!, "hex"),
      Buffer.from(recordSignature(record, credential), "hex"),
    )
  )
    throw new Error("The managed inference discovery record could not be authenticated.");
  return record;
}

export async function hardwareCatalog(installRoot: string, signal?: AbortSignal) {
  const hardware: NativeHardware = {
    platform: process.platform,
    arch: process.arch,
    product: "",
    totalMemoryBytes: os.totalmem(),
    availableMemoryBytes: os.freemem(),
    availableStorageBytes: 0,
    driverVersion: "",
    cudaVersion: "",
    gpuCount: 0,
  };
  if (process.platform === "win32" && process.arch === "arm64") {
    const layout = installLayout(installRoot);
    const space = fs.statfsSync(path.parse(layout.systemRoot).root);
    hardware.availableStorageBytes = space.bavail * space.bsize;
    const [product, gpu] = await Promise.allSettled([
      captureNative(
        path.join(layout.systemRoot, "System32", "reg.exe"),
        ["query", "HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS", "/v", "SystemProductName"],
        { signal, maxBytes: 16_384 },
      ),
      captureNative(path.join(layout.systemRoot, "System32", "nvidia-smi.exe"), ["-q", "-x"], {
        signal,
      }),
    ]);
    if (product.status === "fulfilled")
      hardware.product =
        /SystemProductName\s+REG_SZ\s+([^\r\n]{1,256})/u.exec(product.value)?.[1].trim() ?? "";
    if (gpu.status === "fulfilled") {
      hardware.driverVersion =
        /<driver_version>([\d.]+)<\/driver_version>/u.exec(gpu.value)?.[1] ?? "";
      hardware.cudaVersion = /<cuda_version>([\d.]+)<\/cuda_version>/u.exec(gpu.value)?.[1] ?? "";
      hardware.gpuCount = Number(
        /<attached_gpus>(\d+)<\/attached_gpus>/u.exec(gpu.value)?.[1] ?? "0",
      );
    }
  }
  signal?.throwIfAborted();
  const reasons = nativeEligibility(hardware);
  return {
    schemaVersion: 1,
    event: "catalog",
    eligible: reasons.length === 0,
    reasons,
    hardware,
    models: [
      {
        id: NATIVE_EXPRESS.id,
        model: NATIVE_EXPRESS.model,
        displayName: NATIVE_EXPRESS.displayName,
        downloadBytes:
          NATIVE_EXPRESS.runtime.bytes + NATIVE_EXPRESS.cuda.bytes + NATIVE_EXPRESS.weights.bytes,
        modelBytes: NATIVE_EXPRESS.weights.bytes,
        contextSize: NATIVE_EXPRESS.contextSize,
        license: "Apache-2.0",
        capabilities: { text: true, toolCalls: true, vision: false },
        readiness:
          "Required on this device: native CUDA loading, full offload, and authenticated model response",
      },
    ],
  };
}

export function controlProof(
  credential: string,
  operation: string,
  instance: string,
  nonce: string,
): string {
  return createHmac("sha256", credential)
    .update(JSON.stringify(["nemoclaw-native-inference-control-v1", operation, instance, nonce]))
    .digest("hex");
}

export function equalProof(actual: unknown, expected: string): boolean {
  return (
    typeof actual === "string" &&
    /^[a-f0-9]{64}$/u.test(actual) &&
    timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))
  );
}
