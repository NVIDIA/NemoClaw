// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { ROOT } from "./paths";

export interface StreamSandboxCreateResult {
  status: number;
  output: string;
  sawProgress: boolean;
  forcedReady?: boolean;
}

export interface StreamSandboxCreateOptions {
  readyCheck?: (() => boolean) | null;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  silentPhaseMs?: number;
  logLine?: (line: string) => void;
  // Initial progress phase:
  //   build  — docker-building the sandbox image
  //   upload — pushing the built image into the gateway registry
  //   create — k3s provisioning the pod from the image
  //   ready  — waiting for the pod to reach Ready state
  // Defaults to "build".
  initialPhase?: "build" | "upload" | "create" | "ready";
  spawnImpl?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => StreamableChildProcess;
}

export interface StreamableReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  removeAllListeners?(event?: string): this;
  destroy?(): void;
}

export interface StreamableChildProcess {
  stdout: StreamableReadable | null;
  stderr: StreamableReadable | null;
  kill?(signal?: NodeJS.Signals | number): boolean;
  removeAllListeners?(event?: string | symbol): void;
  unref?(): void;
  on(event: "error", listener: (error: Error & { code?: string }) => void): this;
  on(event: "close", listener: (code: number | null) => void): this;
}

export const BUILD_PROGRESS_PATTERNS: readonly RegExp[] = [
  /^ {2}Building image /,
  /^ {2}Step \d+\/\d+ : /,
  /^#\d+ \[/,
  /^#\d+ (DONE|CACHED)\b/,
];

const UPLOAD_PROGRESS_PATTERNS: readonly RegExp[] = [
  /^ {2}Pushing image /,
  /^\s*\[progress\]/,
  /^ {2}Image .*available in the gateway/,
];

const VISIBLE_PROGRESS_PATTERNS: readonly RegExp[] = [
  ...BUILD_PROGRESS_PATTERNS,
  /^ {2}Context: /,
  /^ {2}Gateway: /,
  /^Successfully built /,
  /^Successfully tagged /,
  /^ {2}Built image /,
  ...UPLOAD_PROGRESS_PATTERNS,
  /^Created sandbox: /,
  /^✓ /,
];

function matchesAny(line: string, patterns: readonly RegExp[]) {
  return patterns.some((pattern) => pattern.test(line));
}

export function streamSandboxCreate(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  options: StreamSandboxCreateOptions = {},
): Promise<StreamSandboxCreateResult> {
  const child: StreamableChildProcess = (options.spawnImpl ?? spawn)("bash", ["-lc", command], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logLine = options.logLine ?? console.log;
  const lines: string[] = [];
  let pending = "";
  let lastPrintedLine = "";
  let sawProgress = false;
  let settled = false;
  let polling = false;
  const pollIntervalMs = options.pollIntervalMs || 2000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs || 5000;
  const silentPhaseMs = options.silentPhaseMs || 15000;
  const startedAt = Date.now();
  let lastOutputAt = startedAt;
  type CreatePhase = "build" | "upload" | "create" | "ready";

  let currentPhase: CreatePhase | null = null;
  let lastHeartbeatPhase: CreatePhase | null = null;
  let lastHeartbeatBucket = -1;
  let resolvePromise: (result: StreamSandboxCreateResult) => void;

  function getDisplayWidth() {
    return Math.max(60, Number(process.stdout.columns || 100));
  }

  function trimDisplayLine(line: string) {
    const width = getDisplayWidth();
    const maxLen = Math.max(40, width - 4);
    if (line.length <= maxLen) return line;
    return `${line.slice(0, Math.max(0, maxLen - 3))}...`;
  }

  function printProgressLine(line: string) {
    const display = trimDisplayLine(line);
    if (display !== lastPrintedLine) {
      logLine(display);
      lastPrintedLine = display;
    }
  }

  function elapsedSeconds() {
    return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  }

  function setPhase(nextPhase: CreatePhase | null) {
    if (!nextPhase || nextPhase === currentPhase) return;
    currentPhase = nextPhase;
    lastHeartbeatPhase = null;
    lastHeartbeatBucket = -1;
    const phaseLine =
      nextPhase === "build"
        ? "  Building sandbox image..."
        : nextPhase === "upload"
          ? "  Uploading image into OpenShell gateway..."
          : nextPhase === "create"
            ? "  Creating sandbox in gateway..."
            : nextPhase === "ready"
              ? "  Waiting for sandbox to become ready..."
              : null;
    if (phaseLine) printProgressLine(phaseLine);
  }

  function flushLine(rawLine: string) {
    const line = rawLine.replace(/\r/g, "").trimEnd();
    if (!line) return;
    lines.push(line);
    lastOutputAt = Date.now();
    if (matchesAny(line, BUILD_PROGRESS_PATTERNS)) {
      setPhase("build");
    } else if (matchesAny(line, UPLOAD_PROGRESS_PATTERNS)) {
      setPhase("upload");
    } else if (/^Created sandbox: /.test(line)) {
      setPhase("create");
    }
    if (shouldShowLine(line) && line !== lastPrintedLine) {
      printProgressLine(line);
      sawProgress = true;
    }
  }

  function shouldShowLine(line: string) {
    return matchesAny(line, VISIBLE_PROGRESS_PATTERNS);
  }

  function onChunk(chunk: Buffer | string) {
    pending += chunk.toString();
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    parts.forEach(flushLine);
  }

  function finish(status: number, overrides: Partial<StreamSandboxCreateResult> = {}) {
    if (settled) return;
    settled = true;
    if (pending) flushLine(pending);
    if (readyTimer) clearInterval(readyTimer);
    clearInterval(heartbeatTimer);
    resolvePromise({
      status,
      output: lines.join("\n"),
      sawProgress,
      ...overrides,
    });
  }

  function detachChild() {
    child.stdout?.removeAllListeners?.("data");
    child.stderr?.removeAllListeners?.("data");
    child.stdout?.destroy?.();
    child.stderr?.destroy?.();
    child.removeAllListeners?.("error");
    child.removeAllListeners?.("close");
    child.unref?.();
  }

  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  const readyTimer = options.readyCheck
    ? setInterval(() => {
        if (settled || polling) return;
        polling = true;
        try {
          let ready = false;
          try {
            ready = !!options.readyCheck?.();
          } catch {
            return;
          }
          if (!ready) return;
          setPhase("ready");
          const detail = "Sandbox reported Ready before create stream exited; continuing.";
          lines.push(detail);
          printProgressLine(`  ${detail}`);
          try {
            child.kill?.("SIGTERM");
          } catch {
            // Best effort only — the child may have already exited.
          }
          detachChild();
          sawProgress = true;
          finish(0, { forcedReady: true });
        } finally {
          polling = false;
        }
      }, pollIntervalMs)
    : null;
  readyTimer?.unref?.();

  setPhase(options.initialPhase ?? "build");
  const heartbeatTimer = setInterval(() => {
    if (settled) return;
    const silentForMs = Date.now() - lastOutputAt;
    if (silentForMs < silentPhaseMs) return;
    const elapsed = elapsedSeconds();
    const bucket = Math.floor(elapsed / 15);
    if (currentPhase === lastHeartbeatPhase && bucket === lastHeartbeatBucket) {
      return;
    }
    const heartbeatLine =
      currentPhase === "upload"
        ? `  Still uploading image into OpenShell gateway... (${elapsed}s elapsed)`
        : currentPhase === "create"
          ? `  Still creating sandbox in gateway... (${elapsed}s elapsed)`
          : currentPhase === "ready"
            ? `  Still waiting for sandbox to become ready... (${elapsed}s elapsed)`
            : `  Still building sandbox image... (${elapsed}s elapsed)`;
    if (trimDisplayLine(heartbeatLine) !== lastPrintedLine) {
      printProgressLine(heartbeatLine);
      lastHeartbeatPhase = currentPhase;
      lastHeartbeatBucket = bucket;
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  return new Promise((resolve) => {
    resolvePromise = resolve;
    child.on("error", (error) => {
      const code = error?.code;
      const detail = code
        ? `spawn failed: ${error.message} (${code})`
        : `spawn failed: ${error.message}`;
      lines.push(detail);
      finish(1);
    });

    child.on("close", (code) => {
      // One last ready-check: the sandbox may have become Ready between the
      // last poll tick and the stream exit (e.g. SSH 255 after "Created sandbox:").
      if (code && code !== 0 && options.readyCheck) {
        try {
          if (options.readyCheck()) {
            finish(0, { forcedReady: true });
            return;
          }
        } catch {
          // Ignore — fall through to normal exit handling.
        }
      }
      finish(code ?? 1);
    });
  });
}
