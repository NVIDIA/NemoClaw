// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export function identity(file: string) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Expected an ordinary exact file.");
  const bytes = fs.readFileSync(file);
  return {
    path: fs.realpathSync(file),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export type OutputEvent = {
  stream: "stdout" | "stderr";
  capturedMs: number;
  text: string;
  terminated: boolean;
};
export class OutputTimeline {
  private readonly decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  private readonly pending = { stdout: "", stderr: "" };
  private retained = 0;
  readonly events: OutputEvent[] = [];
  readonly bytes = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  readonly firstByteMs: { stdout: number | null; stderr: number | null } = {
    stdout: null,
    stderr: null,
  };
  exceeded = false;
  private readonly limit: number;
  constructor(limit = 1024 * 1024) {
    this.limit = limit;
  }
  write(stream: "stdout" | "stderr", bytes: Buffer, capturedMs: number) {
    this.firstByteMs[stream] ??= capturedMs;
    const keep = bytes.subarray(0, Math.max(0, this.limit - this.retained));
    this.retained += keep.length;
    this.exceeded ||= keep.length !== bytes.length;
    if (keep.length) this.bytes[stream].push(Buffer.from(keep));
    const lines = (this.pending[stream] + this.decoders[stream].write(keep)).split("\n");
    this.pending[stream] = lines.pop() ?? "";
    for (const text of lines) {
      if (this.events.length >= 8192) {
        this.exceeded = true;
        break;
      }
      this.events.push({ stream, capturedMs, text, terminated: true });
    }
  }
  finish(capturedMs: number) {
    for (const stream of ["stdout", "stderr"] as const) {
      const text = this.pending[stream] + this.decoders[stream].end();
      if (text && this.events.length < 8192)
        this.events.push({ stream, capturedMs, text, terminated: false });
      this.pending[stream] = "";
    }
  }
  exactMarker(marker: string | null) {
    if (marker === null) return null;
    if (!marker || marker.length > 512 || /[\r\n]/u.test(marker))
      throw new Error("The configuration marker must be one bounded literal.");
    return this.events.find((event) => event.text.includes(marker)) ?? null;
  }
}

export async function stopOwned(child: ChildProcess, environment: NodeJS.ProcessEnv) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  if (!child.pid) return false;
  const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (process.platform === "win32") {
    const executable = path.join(
      environment.SystemRoot ?? environment.SYSTEMROOT ?? "",
      "System32",
      "taskkill.exe",
    );
    await new Promise<void>((resolve) =>
      execFile(
        executable,
        ["/PID", String(child.pid), "/T", "/F"],
        { env: environment, timeout: 5000, windowsHide: true },
        () => resolve(),
      ),
    );
  } else child.kill("SIGKILL");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ended.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Only the exact f8 replay may exceed the generic 15-minute measurement cap.
// Its existing package qualifier allows 20 minutes; the extra 120 seconds are
// diagnostic idle (30s) and cleanup/harvest (90s), not a runtime timeout change.
export const installedOpenClawReplayDeadline = {
  contract: "f8-installed-openclaw-qualification",
  source: "f8a1d8c702c879d2984d76d2e0419641bb1ccd97",
  existingControllerMs: 1_200_000,
  diagnosticIdleMs: 30_000,
  cleanupAndHarvestMs: 90_000,
  applicationMs: 1_320_000,
  collectorMs: 1_350_000,
} as const;

export function assertMeasurementDeadline(timeoutMs: number, contract?: string) {
  const maximum =
    contract === installedOpenClawReplayDeadline.contract
      ? installedOpenClawReplayDeadline.collectorMs
      : 900_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximum)
    throw new Error("The measurement deadline is outside its bound.");
}

export function createCommandOutputRecorder(directory: string) {
  const descriptors: Partial<Record<"stdout" | "stderr", number>> = {};
  let retained = 0;
  const close = () => {
    let failure: unknown;
    for (const stream of ["stdout", "stderr"] as const) {
      const fd = descriptors[stream];
      delete descriptors[stream];
      try {
        if (fd !== undefined) fs.closeSync(fd);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  };
  try {
    for (const stream of ["stdout", "stderr"] as const)
      descriptors[stream] = fs.openSync(path.join(directory, "command-" + stream + ".log"), "wx");
  } catch (error) {
    try {
      close();
    } catch {
      console.error("Output setup also failed handle cleanup.");
    }
    throw error;
  }
  return {
    write(stream: "stdout" | "stderr", chunk: Buffer) {
      const fd = descriptors[stream];
      if (fd === undefined) throw new Error("The output recorder is closed.");
      const keep = chunk.subarray(0, Math.max(0, 1024 * 1024 - retained));
      retained += keep.length;
      let offset = 0;
      while (offset < keep.length) offset += fs.writeSync(fd, keep, offset, keep.length - offset);
    },
    close,
  };
}

export async function measuredCommand(options: {
  executable: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
  marker?: string | null;
  onSpawn?: (pid: number) => void;
  signal?: AbortSignal;
  deadlineContract?: string;
  onOutput?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
}) {
  assertMeasurementDeadline(options.timeoutMs, options.deadlineContract);
  new OutputTimeline().exactMarker(options.marker ?? null);
  const started = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
  const output = new OutputTimeline();
  const child = spawn(options.executable, options.args, {
    env: options.environment,
    cwd: options.cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const observed = {
    exitCode: null as number | null,
    signal: null as NodeJS.Signals | null,
    spawnError: null as string | null,
    observerError: null as string | null,
    timedOut: false,
    aborted: false,
    closed: false,
    rootTerminationConfirmed: true,
  };
  child.once("error", (error) => {
    observed.spawnError = error.message;
  });
  const captureOutput = (stream: "stdout" | "stderr", data: Buffer) => {
    output.write(stream, data, elapsed());
    try {
      options.onOutput?.(stream, data);
    } catch (error) {
      observed.observerError ??= error instanceof Error ? error.message : String(error);
    }
  };
  child.stdout.on("data", (data: Buffer) => captureOutput("stdout", data));
  child.stderr.on("data", (data: Buffer) => captureOutput("stderr", data));
  child.once("exit", (code, signal) => {
    observed.exitCode = code;
    observed.signal = signal;
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => {
      observed.closed = true;
      resolve();
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    if (child.pid) options.onSpawn?.(child.pid);
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.timeoutMs);
      }),
      new Promise<void>((resolve) => {
        aborted = () => {
          observed.aborted = true;
          resolve();
        };
        options.signal?.addEventListener("abort", aborted, { once: true });
        if (options.signal?.aborted) aborted();
      }),
    ]);
    if (!observed.closed) {
      observed.timedOut = !observed.aborted;
      observed.rootTerminationConfirmed = await stopOwned(child, options.environment);
    }
  } catch (error) {
    observed.observerError = error instanceof Error ? error.message : String(error);
    observed.rootTerminationConfirmed = await stopOwned(child, options.environment);
  } finally {
    clearTimeout(timer);
    if (aborted) options.signal?.removeEventListener("abort", aborted);
    if (!observed.closed) {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    }
  }
  output.finish(elapsed());
  return {
    schemaVersion: 1,
    ...observed,
    processId: child.pid ?? null,
    elapsedMs: elapsed(),
    clock: "parent-process.hrtime.bigint capture time",
    firstByteMs: output.firstByteMs,
    firstConfigurationLog: output.exactMarker(options.marker ?? null),
    outputExceeded: output.exceeded,
    lines: output.events,
    stdout: Buffer.concat(output.bytes.stdout).toString("utf8"),
    stderr: Buffer.concat(output.bytes.stderr).toString("utf8"),
    stdoutBase64: Buffer.concat(output.bytes.stdout).toString("base64"),
    stderrBase64: Buffer.concat(output.bytes.stderr).toString("base64"),
  };
}

export function inventory(root: string) {
  const pending = [root];
  let files = 0;
  let bytes = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Inventory does not follow reparse/symbolic links.");
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) {
        files++;
        bytes += fs.statSync(full).size;
      } else throw new Error("Inventory encountered a non-file entry.");
    }
  }
  return { files, logicalBytes: bytes, includesDeclarationsAndSourceMaps: true };
}

export function startupSpans(events: OutputEvent[]) {
  return events.flatMap((event) => {
    const match =
      /startup trace: ([a-zA-Z0-9_.:-]+) ([0-9]+(?:\.[0-9]+)?)ms total=([0-9]+(?:\.[0-9]+)?)ms/u.exec(
        event.text,
      );
    return match
      ? [
          {
            name: match[1],
            durationMs: Number(match[2]),
            upstreamRelativeTotalMs: Number(match[3]),
            capturedMs: event.capturedMs,
            stream: event.stream,
            literal: event.text,
          },
        ]
      : [];
  });
}

// Only for this probe's fresh private directories, which have no guarded owner handles.
export function publishFixtureRecord(file: string, value: unknown) {
  const temporary = file + ".writing";
  fs.writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", flush: true });
  if (fs.existsSync(file)) throw new Error("A probe record already exists.");
  fs.renameSync(temporary, file);
}

export function readFixtureRecord(file: string): unknown {
  const fd = fs.openSync(file, "r");
  try {
    const limit = 8 * 1024 * 1024;
    if (!fs.fstatSync(fd).isFile()) throw new Error("A probe record must be a regular file.");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > limit || buffer[size - 1] !== 10)
      throw new Error("A probe record is incomplete or exceeds its limit.");
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}
