// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EDGE_RELATIVE = path.join("Microsoft", "Edge", "Application", "msedge.exe");
const DEVTOOLS = /^([1-9][0-9]{0,4})\r?\n(\/devtools\/browser\/[A-Za-z0-9-]{1,128})\r?\n?$/u;

export function standardEdgeCandidates(environment: NodeJS.ProcessEnv) {
  const roots = [
    environment.ProgramFiles,
    environment["ProgramFiles(x86)"],
    environment.PROGRAMFILES,
  ].filter((value): value is string => Boolean(value) && path.win32.isAbsolute(value!));
  return [
    ...new Map(
      roots.map((root) => {
        const candidate = path.win32.join(root, EDGE_RELATIVE);
        return [candidate.toLowerCase(), candidate];
      }),
    ).values(),
  ];
}

export function peMachine(bytes: Buffer) {
  if (bytes.length < 88 || bytes.subarray(0, 2).toString("ascii") !== "MZ")
    throw new Error("Microsoft Edge does not have a valid PE header.");
  const offset = bytes.readUInt32LE(60);
  if (offset < 64 || offset > bytes.length - 24 || bytes.readUInt32LE(offset) !== 0x4550)
    throw new Error("Microsoft Edge does not have a valid PE header.");
  return bytes.readUInt16LE(offset + 4);
}

export function parseDevToolsActivePort(text: string) {
  const match = DEVTOOLS.exec(text);
  if (!match) throw new Error("Microsoft Edge did not publish a valid CDP endpoint.");
  const port = Number(match[1]);
  if (port > 65535) throw new Error("Microsoft Edge did not publish a valid CDP endpoint.");
  return { port, path: match[2]! };
}

export function validateEdgeMetadata(value: any, expectedPath: string) {
  if (value?.path?.toLowerCase() !== expectedPath.toLowerCase())
    throw new Error("Microsoft Edge resolved outside its standard installation path.");
  if (typeof value.version !== "string" || !/^[0-9]+(?:\.[0-9]+){1,3}$/u.test(value.version))
    throw new Error("Microsoft Edge has an invalid product version.");
  if (value.productName !== "Microsoft Edge")
    throw new Error("Microsoft Edge has an unexpected product identity.");
  if (value.originalFilename?.toLowerCase() !== "msedge.exe")
    throw new Error("Microsoft Edge has an unexpected original filename.");
  if (value.reparsePoint !== false)
    throw new Error("Microsoft Edge cannot be loaded through a reparse point.");
  if (value.signatureStatus !== "Valid") {
    const status =
      typeof value.signatureStatus === "string" && /^[A-Za-z]{1,64}$/u.test(value.signatureStatus)
        ? value.signatureStatus
        : "InvalidStatus";
    throw new Error(`Microsoft Edge Authenticode status is ${status}.`);
  }
  if (
    typeof value.signerSubject !== "string" ||
    !/(?:^|,\s*)O=Microsoft Corporation(?:,|$)/u.test(value.signerSubject)
  )
    throw new Error("Microsoft Edge is not signed by Microsoft Corporation.");
  if (
    typeof value.signerThumbprint !== "string" ||
    !/^[A-F0-9]{40,128}$/u.test(value.signerThumbprint)
  )
    throw new Error("Microsoft Edge has an invalid signer thumbprint.");
  return value as {
    path: string;
    version: string;
    productName: "Microsoft Edge";
    originalFilename: string;
    reparsePoint: false;
    signatureStatus: "Valid";
    signerSubject: string;
    signerThumbprint: string;
  };
}

function hash(file: string) {
  const bytes = fs.readFileSync(file);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    machine: peMachine(bytes),
  };
}

async function powershellMetadata(environment: NodeJS.ProcessEnv, file: string, pid?: number) {
  const systemRoot = environment.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot))
    throw new Error("Microsoft Edge identity probe requires the Windows system root.");
  const powershell = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script =
    pid === undefined
      ? "$ErrorActionPreference='Stop';$f=Get-Item -LiteralPath $env:NEMOCLAW_EDGE_INSPECT_PATH;$c=[Security.Cryptography.X509Certificates.X509Certificate2]::new([Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($f.FullName));[ordered]@{path=$f.FullName;version=$f.VersionInfo.FileVersion;productName=$f.VersionInfo.ProductName;originalFilename=$f.VersionInfo.OriginalFilename;reparsePoint=[bool]($f.Attributes -band [IO.FileAttributes]::ReparsePoint);signerSubject=$c.Subject;signerThumbprint=$c.Thumbprint}|ConvertTo-Json -Compress"
      : "$p=Get-Process -Id ([int]$env:NEMOCLAW_EDGE_INSPECT_PID) -ErrorAction Stop;[ordered]@{pid=$p.Id;path=$p.Path;creationFiletime=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}|ConvertTo-Json -Compress";
  let result;
  try {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    result = await execFileAsync(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      {
        env: {
          ...environment,
          POWERSHELL_TELEMETRY_OPTOUT: "1",
          PSModulePath: path.win32.join(
            systemRoot,
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "Modules",
          ),
          ...(pid === undefined
            ? { NEMOCLAW_EDGE_INSPECT_PATH: file }
            : { NEMOCLAW_EDGE_INSPECT_PID: String(pid) }),
        },
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
    );
  } catch (error: any) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.slice(0, 4096) : "";
    const stdout = typeof error?.stdout === "string" ? error.stdout.slice(0, 4096) : "";
    const code =
      typeof error?.code === "string" || typeof error?.code === "number"
        ? String(error.code).slice(0, 64)
        : "unknown";
    const detail = [stderr, stdout, typeof error?.message === "string" ? error.message : ""]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 4096);
    const execution = [
      error?.killed === true ? "killed=true" : "",
      typeof error?.signal === "string" ? `signal=${error.signal.slice(0, 32)}` : "",
    ]
      .filter(Boolean)
      .join(",");
    throw new Error(
      `Microsoft Edge identity probe failed (${code}${execution ? `;${execution}` : ""})${detail ? `: ${detail}` : "."}`,
    );
  }
  const value = JSON.parse(result.stdout.trim());
  if (typeof value?.probeError === "string")
    throw new Error(`Microsoft Edge identity probe: ${value.probeError.slice(0, 2048)}`);
  return value;
}

async function offlineTrust(environment: NodeJS.ProcessEnv, file: string) {
  const installRoot = environment.NEMOCLAW_NATIVE_INSTALL_ROOT;
  if (!installRoot || !path.win32.isAbsolute(installRoot))
    throw new Error("Microsoft Edge trust requires the installed NemoClaw root.");
  const launcher = path.win32.join(installRoot, "bin", "NemoClaw.exe");
  const result = await execFileAsync(launcher, ["--edge-offline-trust", file], {
    env: environment,
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 4096,
    encoding: "utf8",
  });
  const value = JSON.parse(result.stdout.trim());
  if (value?.schemaVersion !== 1 || value?.signatureStatus !== "Valid")
    throw new Error("Microsoft Edge offline Authenticode verification failed.");
  return { signatureStatus: "Valid" as const };
}

export async function detectNativeEdge(environment: NodeJS.ProcessEnv = process.env) {
  const systemRoot = environment.SystemRoot;
  if (
    process.platform !== "win32" ||
    process.arch !== "arm64" ||
    !systemRoot ||
    !path.win32.isAbsolute(systemRoot)
  )
    throw new Error("Native ARM64 Microsoft Edge requires Windows ARM64.");
  const candidates = standardEdgeCandidates(environment).filter((candidate) =>
    fs.existsSync(candidate),
  );
  if (candidates.length !== 1)
    throw new Error("A unique standard Microsoft Edge installation was not found.");
  const file = candidates[0]!;
  const before = hash(file);
  if (before.machine !== 0xaa64)
    throw new Error("Microsoft Edge is not a native ARM64 executable.");
  const [metadata, trust] = await Promise.all([
    powershellMetadata(environment, file),
    offlineTrust(environment, file),
  ]);
  const signed = validateEdgeMetadata({ ...metadata, ...trust }, file);
  const after = hash(file);
  if (before.bytes !== after.bytes || before.sha256 !== after.sha256 || after.machine !== 0xaa64)
    throw new Error("Microsoft Edge changed during identity verification.");
  return {
    schemaVersion: 1,
    classification: "native-arm64-microsoft-edge",
    path: signed.path,
    version: signed.version,
    productName: signed.productName,
    originalFilename: signed.originalFilename,
    architecture: "arm64" as const,
    machine: 0xaa64,
    bytes: after.bytes,
    sha256: after.sha256,
    signatureStatus: signed.signatureStatus,
    signerSubject: signed.signerSubject,
    signerThumbprint: signed.signerThumbprint,
    provenance: "standard-windows-microsoft-edge-installation" as const,
  };
}

async function stopEdge(child: ChildProcess, endpoint?: { port: number; path: string }) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (endpoint) {
    await new Promise<void>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}${endpoint.path}`);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        socket.close();
        resolve();
      }, 1000);
      socket.addEventListener("open", () =>
        socket.send(JSON.stringify({ id: 1, method: "Browser.close" })),
      );
      socket.addEventListener("close", done, { once: true });
      socket.addEventListener("error", done, { once: true });
    });
  }
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null)
    throw new Error("The owned Microsoft Edge process did not close.");
}

export async function startNativeEdgeBrowser(options: {
  profileRoot: string;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}) {
  const environment = options.environment ?? process.env;
  if (environment.NEMOCLAW_RUNTIME_JOB_OWNED !== "1")
    throw new Error("Microsoft Edge requires the guardian-owned runtime job.");
  const identity = await detectNativeEdge(environment);
  if (fs.existsSync(options.profileRoot))
    throw new Error("The Microsoft Edge profile must be fresh.");
  fs.mkdirSync(options.profileRoot);
  const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exceeded: false };
  const child = spawn(
    identity.path,
    [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${options.profileRoot}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "--disable-component-update",
    ],
    {
      cwd: options.profileRoot,
      env: Object.fromEntries(
        Object.entries(environment).filter(
          ([name, value]) =>
            value !== undefined &&
            [
              "SystemRoot",
              "WINDIR",
              "SystemDrive",
              "TEMP",
              "TMP",
              "LOCALAPPDATA",
              "ProgramFiles",
              "ProgramFiles(x86)",
              "PROGRAMFILES",
            ].includes(name),
        ),
      ),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const capture = (name: "stdout" | "stderr", chunk: Buffer) => {
    const remaining = Math.max(0, 64 * 1024 - output[name].length);
    output[name] = Buffer.concat([output[name], chunk.subarray(0, remaining)]);
    if (chunk.length > remaining) {
      output.exceeded = true;
      child.kill();
    }
  };
  child.stdout!.on("data", (chunk: Buffer) => capture("stdout", chunk));
  child.stderr!.on("data", (chunk: Buffer) => capture("stderr", chunk));
  let expectedClose = false;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => {});
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (!expectedClose)
        rejectFailure(
          new Error(`The owned Microsoft Edge process exited unexpectedly (${code ?? 1}).`),
        );
      resolve();
    });
  });
  let endpoint: { port: number; path: string } | undefined;
  const active = path.join(options.profileRoot, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  try {
    while (!endpoint && Date.now() < deadline) {
      options.signal?.throwIfAborted();
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Microsoft Edge exited before publishing its CDP endpoint.");
      if (fs.existsSync(active)) {
        const stat = fs.statSync(active);
        if (!stat.isFile() || stat.size > 512)
          throw new Error("Microsoft Edge published an invalid CDP endpoint file.");
        endpoint = parseDevToolsActivePort(fs.readFileSync(active, "utf8"));
        break;
      }
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 50))]);
    }
    if (!endpoint)
      throw new Error("Microsoft Edge did not become ready within its host startup bound.");
    if (output.exceeded) throw new Error("Microsoft Edge startup output exceeded its bound.");
    const generation = await powershellMetadata(environment, identity.path, child.pid);
    if (
      generation.pid !== child.pid ||
      generation.path?.toLowerCase() !== identity.path.toLowerCase() ||
      typeof generation.creationFiletime !== "string" ||
      !/^[0-9]{15,20}$/u.test(generation.creationFiletime)
    )
      throw new Error("Microsoft Edge process generation could not be bound.");
    if (hash(identity.path).sha256 !== identity.sha256)
      throw new Error("Microsoft Edge changed after startup.");
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        options.signal?.removeEventListener("abort", abort);
        expectedClose = true;
        await stopEdge(child, endpoint);
        fs.rmSync(options.profileRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 50,
        });
        if (fs.existsSync(options.profileRoot))
          throw new Error("The Microsoft Edge profile was not removed.");
      })());
    const abort = () => {
      void close().catch(() => {});
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    return {
      identity,
      process: { pid: child.pid!, creationTimeFileTime: generation.creationFiletime },
      endpoint,
      output,
      inheritedKillOnCloseJob: true,
      failure,
      close,
    };
  } catch (error) {
    expectedClose = true;
    await stopEdge(child, endpoint).catch(() => {});
    fs.rmSync(options.profileRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
    throw error;
  }
}
