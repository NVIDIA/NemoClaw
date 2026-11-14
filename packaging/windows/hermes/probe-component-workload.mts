// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function fileIdentity(file: string) {
  const bytes = fs.readFileSync(file);
  const peOffset = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1;
  const machine =
    bytes.toString("ascii", 0, 2) === "MZ" &&
    peOffset >= 64 &&
    peOffset + 6 <= bytes.length &&
    bytes.toString("ascii", peOffset, peOffset + 4) === "PE\u0000\u0000"
      ? bytes.readUInt16LE(peOffset + 4)
      : null;
  return {
    path: file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    peMachine: machine,
    architecture:
      new Map<number, string>([
        [0x14c, "x86"],
        [0x8664, "x64"],
        [0xaa64, "arm64"],
      ]).get(machine ?? 0) ?? "non-PE-or-unknown",
  };
}

export function errorDetail(error: unknown): Record<string, unknown> {
  const source =
    error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
  return Object.fromEntries(
    ["name", "message", "code", "errno", "syscall", "path"].map((key) => [
      key,
      source[key] ?? null,
    ]),
  );
}

export function decodeDiagnostic(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2, bytes.length - ((bytes.length - 2) % 2)));
    return body.swap16().toString("utf16le");
  }
  const pairs = Math.floor(Math.min(bytes.length, 512) / 2);
  let evenNulls = 0;
  let oddNulls = 0;
  for (let index = 0; index < pairs; index += 1) {
    if (bytes[index * 2] === 0) evenNulls += 1;
    if (bytes[index * 2 + 1] === 0) oddNulls += 1;
  }
  if (pairs >= 4 && oddNulls / pairs > 0.3 && evenNulls / pairs < 0.05)
    return bytes.toString("utf16le");
  return bytes.toString("utf8").replace(/^\uFEFF/u, "");
}

// taskkill /T is supported by Windows PowerShell 5.1-era Windows APIs as well.
// Always target the exact owned PID; never enumerate or kill by process name.
export async function stopOwnedChild(
  child: ChildProcess,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  if (!child.pid) return false;
  const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
  if (process.platform === "win32") {
    const taskkill = path.join(
      environment.SYSTEMROOT ?? environment.SystemRoot ?? "",
      "System32",
      "taskkill.exe",
    );
    await new Promise<void>((resolve) => {
      execFile(
        taskkill,
        ["/PID", String(child.pid), "/T", "/F"],
        { env: environment, windowsHide: true, timeout: 5000 },
        () => resolve(),
      );
    });
  } else child.kill("SIGKILL");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.unref();
  }
}

export type CommandResult = {
  executable: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputExceeded: boolean;
  stdout: string;
  stderr: string;
  error: Record<string, unknown> | null;
  childClosed: boolean;
  elapsedMs: number;
};

export async function command(
  file: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  timeout = 30_000,
): Promise<CommandResult> {
  const started = Date.now();
  const child = spawn(file, args, {
    env: environment,
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result: CommandResult = {
    executable: file,
    args,
    exitCode: null,
    signal: null,
    timedOut: false,
    outputExceeded: false,
    stdout: "",
    stderr: "",
    error: null,
    childClosed: false,
    elapsedMs: 0,
  };
  let stopping: Promise<boolean> | undefined;
  const stop = () => {
    stopping ??= stopOwnedChild(child, environment);
    return stopping;
  };
  const closed = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      result.error = errorDetail(error);
    });
    child.once("close", (code, signal) => {
      result.exitCode = code;
      result.signal = signal;
      result.childClosed = true;
      resolve();
    });
  });
  const output = {
    stdout: { chunks: [] as Buffer[], bytes: 0 },
    stderr: { chunks: [] as Buffer[], bytes: 0 },
  };
  for (const [channel, stream] of [
    ["stdout", child.stdout],
    ["stderr", child.stderr],
  ] as const) {
    stream.on("data", (chunk: Buffer) => {
      const captured = output[channel];
      const remaining = Math.max(0, 64 * 1024 - captured.bytes);
      if (remaining > 0) captured.chunks.push(chunk.subarray(0, remaining));
      captured.bytes += Math.min(remaining, chunk.length);
      if (chunk.length > remaining) {
        result.outputExceeded = true;
        void stop();
      }
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(async () => {
      result.timedOut = true;
      await stop();
      // A retained descendant pipe must not keep the probe process alive.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve();
    }, timeout);
  });
  await Promise.race([closed, deadline]);
  clearTimeout(timer);
  if (stopping) await stopping;
  result.stdout = decodeDiagnostic(Buffer.concat(output.stdout.chunks));
  result.stderr = decodeDiagnostic(Buffer.concat(output.stderr.chunks));
  result.elapsedMs = Date.now() - started;
  return result;
}

export function commandPassed(result: CommandResult, sentinel: string) {
  return (
    result.exitCode === 0 &&
    result.signal === null &&
    result.error === null &&
    !result.timedOut &&
    !result.outputExceeded &&
    result.childClosed &&
    result.stdout.split(/\r?\n/u).includes(sentinel)
  );
}

async function main() {
  const [runtime, output, nonce] = process.argv.slice(2);
  if (process.platform !== "win32" || !runtime || !output || !/^[a-f0-9]{24}$/u.test(nonce ?? ""))
    throw new Error("The component workload requires Windows and an exact probe identity.");
  const bash = path.join(runtime, "git", "bin", "bash.exe");
  const python = path.join(runtime, "hermes-agent", "venv", "Scripts", "python.exe");
  const sentinel = `NEMOCLAW_COMPONENT_${nonce}`;
  const result: {
    schemaVersion: number;
    nonce: string;
    architecture: string;
    components: (CommandResult & { id: string; passed: boolean })[];
    passed: boolean;
    error?: Record<string, unknown>;
  } = {
    schemaVersion: 1,
    nonce,
    architecture: process.arch,
    components: [],
    passed: false,
  };
  try {
    const bashResult = await command(
      bash,
      [
        "--noprofile",
        "--norc",
        "-c",
        `set -e; /usr/bin/printf.exe '%s\\n' '${sentinel}' > bash-proof.txt; /usr/bin/cat.exe bash-proof.txt`,
      ],
      process.env,
      process.cwd(),
    );
    result.components.push({
      id: "portable-git-bash-coreutils",
      ...bashResult,
      passed:
        commandPassed(bashResult, sentinel) &&
        fs.existsSync("bash-proof.txt") &&
        fs.readFileSync("bash-proof.txt", "utf8").trim() === sentinel,
    });
    const pythonSource = [
      "import json, os, pathlib, subprocess, sys, tempfile",
      `expected = ${JSON.stringify(sentinel)}`,
      `expected_base = ${JSON.stringify(path.join(runtime, "hermes-agent", ".hermes-runtime", "python", "cpython-3.11.16-windows-aarch64-none", "python.exe"))}`,
      "assert sys.version_info[:3] == (3, 11, 16), sys.version",
      "assert os.path.normcase(os.path.realpath(sys._base_executable)) == os.path.normcase(os.path.realpath(expected_base)), sys._base_executable",
      "assert sys.prefix != sys.base_prefix, 'The official venv is not active'",
      "print(json.dumps({'executable': sys.executable, 'baseExecutable': sys._base_executable, 'version': sys.version, 'prefix': sys.prefix, 'basePrefix': sys.base_prefix}), flush=True)",
      "with tempfile.TemporaryDirectory() as directory:",
      "    target = pathlib.Path(directory) / 'proof.txt'",
      "    target.write_text(expected, encoding='utf-8')",
      "    observed = subprocess.check_output([sys.executable, '-I', '-c', 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text())', str(target)], text=True, timeout=10).strip()",
      "    assert observed == expected",
      "print(expected)",
    ].join("\n");
    const pythonResult = await command(
      python,
      ["-I", "-c", pythonSource],
      process.env,
      process.cwd(),
    );
    result.components.push({
      id: "official-python-venv-temp-child",
      ...pythonResult,
      passed: commandPassed(pythonResult, sentinel),
    });
    result.passed =
      result.components.length === 2 && result.components.every((component) => component.passed);
  } catch (error) {
    result.error = errorDetail(error);
  }
  fs.writeFileSync(`${output}.tmp`, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(`${output}.tmp`, output);
  process.exitCode = result.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(JSON.stringify(errorDetail(error)));
    process.exitCode = 1;
  });
}
