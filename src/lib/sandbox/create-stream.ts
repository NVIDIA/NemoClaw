// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { ROOT } from "../state/paths";

export interface StreamSandboxCreateResult {
  status: number;
  output: string;
  sawProgress: boolean;
  forcedReady?: boolean;
}

export interface StreamSandboxCreateOptions {
  readyCheck?: (() => boolean) | null;
  failureCheck?: (() => string | null | undefined) | null;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  silentPhaseMs?: number;
  logLine?: (line: string) => void;
  // Optional guard for the early-ready escape hatch. When set, readyCheck()
  // alone cannot detach the create stream until at least one streamed output
  // line matches a configured pattern.
  readyCheckOutputPatterns?: readonly RegExp[];
  // Initial progress phase:
  //   build  — docker-building the sandbox image
  //   upload — pushing the built image into the gateway registry
  //   create — gateway provisioning the sandbox from the image
  //   ready  — waiting for the sandbox to reach Ready state
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
  /^\s*(?:✓\s*)?Image .*available in the gateway/,
];

// Pull-phase indicators. Detect classic Docker pull output (`<tag>: Pulling
// from <ref>`, `<id>: Pulling fs layer / Downloading / Extracting / Pull
// complete`, `Status: Downloaded`, `Digest:`) plus BuildKit pull progress
// (`#N resolve <ref>`, `#N sha256:<id> <size> / <total>`). The tag prefix
// regex uses [^:\s]+ so non-lowercase tags (`v1.2.3`, `cuda-12.5`, `12.4`)
// also match. See #1829.
const PULL_PROGRESS_PATTERNS: readonly RegExp[] = [
  /^\s*(?:[^:\s]+:\s+)?Pulling from \S+/,
  /^\s*[a-f0-9]{6,}: (?:Pulling fs layer|Waiting|Downloading|Extracting|Pull complete|Verifying Checksum|Download complete)\b/,
  /^\s*Status: (?:Downloaded|Image is up to date)/,
  /^\s*Digest: sha256:[a-f0-9]{8,}/,
  /^\s*#\d+\s+(?:resolve\s+\S+|sha256:[a-f0-9]+\s+[\d.]+\s*(?:B|KB|MB|GB)\s*\/)/,
];

const VISIBLE_PROGRESS_PATTERNS: readonly RegExp[] = [
  ...BUILD_PROGRESS_PATTERNS,
  /^ {2}Context: /,
  /^ {2}Gateway: /,
  /^Successfully built /,
  /^Successfully tagged /,
  /^ {2}Built image /,
  ...UPLOAD_PROGRESS_PATTERNS,
  ...PULL_PROGRESS_PATTERNS,
  /^Created sandbox: /,
  /^Creating sandbox/i,
  /^Starting sandbox/i,
  /^✓ /,
];

const VM_READY_DETACH_OUTPUT_PATTERNS: readonly RegExp[] = [/Setting up NemoClaw/];

function matchesAny(line: string, patterns: readonly RegExp[]) {
  return patterns.some((pattern) => pattern.test(line));
}

function selectedDrivers(env: NodeJS.ProcessEnv): string[] {
  const raw =
    env.OPENSHELL_DRIVERS ??
    process.env.OPENSHELL_DRIVERS ??
    (process.platform === "darwin" ? "vm" : "docker");
  return raw
    .split(",")
    .map((driver) => driver.trim())
    .filter(Boolean);
}

function getReadyCheckOutputPatterns(
  env: NodeJS.ProcessEnv,
  patterns: readonly RegExp[] | undefined,
): readonly RegExp[] {
  if (patterns) return patterns;
  return selectedDrivers(env).includes("vm") ? VM_READY_DETACH_OUTPUT_PATTERNS : [];
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
  const readyCheckOutputPatterns = getReadyCheckOutputPatterns(
    env,
    options.readyCheckOutputPatterns,
  );
  let readyCheckOutputMatched = readyCheckOutputPatterns.length === 0;
  let printedReadyCheckOutputWait = false;
  let settled = false;
  let polling = false;
  const pollIntervalMs = options.pollIntervalMs || 2000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs || 5000;
  const silentPhaseMs = options.silentPhaseMs || 15000;
  const startedAt = Date.now();
  let lastOutputAt = startedAt;
  type CreatePhase = "pull" | "build" | "upload" | "create" | "ready";

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
      nextPhase === "pull"
        ? "  Pulling base image from registry..."
        : nextPhase === "build"
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
    if (!readyCheckOutputMatched && matchesAny(line, readyCheckOutputPatterns)) {
      readyCheckOutputMatched = true;
    }
    if (/^ {2}Built image /.test(line)) {
      setPhase("create");
    } else if (matchesAny(line, BUILD_PROGRESS_PATTERNS)) {
      setPhase("build");
    } else if (matchesAny(line, PULL_PROGRESS_PATTERNS)) {
      setPhase("pull");
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

  function flushPendingLine() {
    if (!pending) return;
    const trailing = pending;
    pending = "";
    flushLine(trailing);
  }

  function finish(status: number, overrides: Partial<StreamSandboxCreateResult> = {}) {
    if (settled) return;
    settled = true;
    flushPendingLine();
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
          if (ready) {
            setPhase("ready");
            if (!readyCheckOutputMatched) {
              if (!printedReadyCheckOutputWait) {
                const detail =
                  "Sandbox reported Ready; waiting for startup command output before detaching.";
                lines.push(detail);
                printProgressLine(`  ${detail}`);
                printedReadyCheckOutputWait = true;
              }
              return;
            }
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
            return;
          }

          const failure = options.failureCheck?.();
          if (!failure) return;
          const detail = String(failure);
          lines.push(detail);
          printProgressLine(`  ${detail}`);
          try {
            child.kill?.("SIGTERM");
          } catch {
            // Best effort only — the child may have already exited.
          }
          detachChild();
          sawProgress = true;
          finish(1);
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
      currentPhase === "pull"
        ? `  Still pulling base image from registry... (${elapsed}s elapsed)`
        : currentPhase === "upload"
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
      flushPendingLine();
      if (code && code !== 0 && options.readyCheck) {
        try {
          if (options.readyCheck() && readyCheckOutputMatched) {
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
