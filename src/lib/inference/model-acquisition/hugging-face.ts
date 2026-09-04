// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { redactFull, redactFullWithUrls } from "../../security/redact";

const HF_TOKEN_ENV_KEYS = ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"] as const;
const HF_RATE_LIMIT_PATTERN = /\b429\b|too many requests|rate[\s_-]*limit/i;
const MODEL_DOWNLOAD_HEARTBEAT_MS = 30_000;
const DEFAULT_MODEL_DOWNLOAD_STALL_TIMEOUT_MS = 10 * 60 * 1000;
const MODEL_DOWNLOAD_STALL_TIMEOUT_ENV = "NEMOCLAW_HF_DOWNLOAD_STALL_TIMEOUT";
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const CONTAINER_CLEANUP_TIMEOUT_MS = 10_000;
const HF_DOWNLOAD_CACHE_CONTAINER_DIR = "/tmp/nemoclaw-huggingface";
const HF_REPOSITORY_ID_MAX_LENGTH = 96;
const HF_PENDING_OUTPUT_MAX_CHARS = 64 * 1024;
const HF_REPOSITORY_COMPONENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const HF_SENSITIVE_HEADER_AT_STREAM_BOUNDARY =
  /\b(?:authorization|proxy-authorization|cookie|set-cookie)[ \t]*[:=][^\r\n]*(?:\r\n|[\r\n])$/i;
const TAIL_MAX = 50;

export interface HuggingFaceModelAcquisitionRequest {
  readonly credentialEnv?: NodeJS.ProcessEnv;
  readonly dockerEnv: Readonly<Record<string, string>>;
  readonly downloaderImage: string;
  /** When set, download exactly one repository-relative file. */
  readonly filename?: string;
  readonly hostCacheDir: string;
  readonly repository: string;
  readonly revision?: string;
  readonly spawnDocker: (
    args: readonly string[],
    options?: Parameters<typeof spawn>[2],
  ) => ReturnType<typeof spawn>;
  readonly userIdentity: string | null;
}

export interface HuggingFaceModelAcquisitionObserver {
  readonly logLine: (line: string) => void;
  readonly onRateLimit: () => void;
}

export type HuggingFaceModelAcquisitionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export type HfDownloadAuthentication =
  | { readonly authenticated: false }
  | { readonly authenticated: true; readonly source: (typeof HF_TOKEN_ENV_KEYS)[number] };

function pickHfTokenEntry(
  env: NodeJS.ProcessEnv = process.env,
): { key: (typeof HF_TOKEN_ENV_KEYS)[number]; value: string } | null {
  for (const key of HF_TOKEN_ENV_KEYS) {
    const value = String(env[key] ?? "").trim();
    if (value) return { key, value };
  }
  return null;
}

/** Return only the presence and source of Hugging Face authentication, never its value. */
export function hfDownloadAuthentication(
  env: NodeJS.ProcessEnv = process.env,
): HfDownloadAuthentication {
  const entry = pickHfTokenEntry(env);
  return entry ? { authenticated: true, source: entry.key } : { authenticated: false };
}

/**
 * Return the key-only Docker environment argument so a token never enters the
 * host process list.
 */
export function buildHfTokenDockerArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const entry = pickHfTokenEntry(env);
  return entry ? ["-e", entry.key] : [];
}

/** Supply the matching token value to Docker's environment outside argv. */
export function buildHfTokenForwardEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const entry = pickHfTokenEntry(env);
  return entry ? { [entry.key]: entry.value } : {};
}

function hfDownloadCacheMount(hostCacheDir: string): string {
  const normalized = path.posix.normalize(hostCacheDir);
  if (
    !path.posix.isAbsolute(hostCacheDir) ||
    normalized !== hostCacheDir ||
    hostCacheDir.includes(":")
  ) {
    throw new Error("Hugging Face cache must be a normalized absolute path without ':'");
  }
  return `${normalized}:${HF_DOWNLOAD_CACHE_CONTAINER_DIR}`;
}

function hostUserDockerArgs(identity: string | null): string[] {
  if (identity !== null && !/^[1-9][0-9]*:(?:0|[1-9][0-9]*)$/.test(identity)) {
    throw new Error(
      "Hugging Face model download user must be one non-root numeric uid and numeric gid",
    );
  }
  return identity ? ["--user", identity] : [];
}

function exactFilenameArgs(filename: string | undefined): string[] {
  if (filename === undefined) return [];
  const normalized = path.posix.normalize(filename);
  if (
    filename.length === 0 ||
    filename.includes("\0") ||
    filename.startsWith("-") ||
    path.posix.isAbsolute(filename) ||
    normalized !== filename ||
    normalized === "." ||
    normalized.startsWith("../")
  ) {
    throw new Error("Hugging Face filename must be one normalized repository-relative path");
  }
  return [filename];
}

export function isValidHuggingFaceRepositoryId(repository: string): boolean {
  const components = repository.split("/");
  return !(
    repository.length === 0 ||
    repository.length > HF_REPOSITORY_ID_MAX_LENGTH ||
    components.length > 2 ||
    components.some((component) => !HF_REPOSITORY_COMPONENT_PATTERN.test(component)) ||
    repository.includes("--") ||
    repository.includes("..") ||
    repository.endsWith(".git")
  );
}

function repositoryArg(repository: string): string {
  if (!isValidHuggingFaceRepositoryId(repository)) {
    throw new Error("Hugging Face repository must be one valid repository ID");
  }
  return repository;
}

export function buildHuggingFaceModelDownloadArgv(
  request: HuggingFaceModelAcquisitionRequest,
  containerName?: string,
): string[] {
  const credentialEnv = request.credentialEnv ?? process.env;
  return [
    "run",
    "-t",
    "--rm",
    "--pull=never",
    ...(containerName ? ["--name", containerName] : []),
    ...hostUserDockerArgs(request.userIdentity),
    "--entrypoint",
    "hf",
    "-v",
    hfDownloadCacheMount(request.hostCacheDir),
    "-e",
    `HF_HOME=${HF_DOWNLOAD_CACHE_CONTAINER_DIR}`,
    ...buildHfTokenDockerArgs(credentialEnv),
    request.downloaderImage,
    "download",
    repositoryArg(request.repository),
    ...exactFilenameArgs(request.filename),
    ...(request.revision ? ["--revision", request.revision] : []),
  ];
}

/**
 * How long the download may run with zero new hf output before NemoClaw
 * treats it as stalled and aborts, rather than waiting indefinitely for an
 * external wrapper timeout to kill the process (#10346).
 */
function modelDownloadStallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MODEL_DOWNLOAD_STALL_TIMEOUT_ENV];
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_MODEL_DOWNLOAD_STALL_TIMEOUT_MS;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_MODEL_DOWNLOAD_STALL_TIMEOUT_MS;
  // A finite `seconds` can still leave the representable range once scaled to
  // milliseconds, and a sub-millisecond value floors to zero. Either result
  // would disable the abort this timeout exists to enforce — `idleMs >=
  // Infinity` never holds, and a zero window aborts a healthy download at
  // once — so treat both as unusable and keep the default.
  const timeoutMs = Math.floor(seconds * 1000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    return DEFAULT_MODEL_DOWNLOAD_STALL_TIMEOUT_MS;
  }
  return timeoutMs;
}

function dockerEndpointIdentity(env: Readonly<Record<string, string>>): string {
  const dockerContext = env.DOCKER_CONTEXT?.trim();
  if (dockerContext) return `Docker context ${redactFull(dockerContext)}`;
  const dockerHost = env.DOCKER_HOST?.trim();
  return dockerHost
    ? `Docker host ${redactFullWithUrls(dockerHost)}`
    : "the default Docker endpoint";
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${String(seconds)}s`;
  return `${String(minutes)}m ${String(seconds)}s`;
}

function redactHfDownloadOutput(text: string, tokenValue: string | null): string {
  const withoutKnownToken = tokenValue ? text.split(tokenValue).join("<REDACTED>") : text;
  return redactFull(withoutKnownToken);
}

function redactHfDownloadOutputChunks(
  chunks: readonly { text: string; stream: NodeJS.WriteStream }[],
  tokenValue: string | null,
): string[] {
  const joined = chunks.map((chunk) => chunk.text).join("");
  const tokenSpans: { start: number; end: number }[] = [];
  if (tokenValue) {
    let searchFrom = 0;
    while (searchFrom < joined.length) {
      const start = joined.indexOf(tokenValue, searchFrom);
      if (start < 0) break;
      tokenSpans.push({ start, end: start + tokenValue.length });
      searchFrom = start + tokenValue.length;
    }
  }

  let chunkStart = 0;
  const tokenRedactedChunks = chunks.map((chunk) => {
    const chunkEnd = chunkStart + chunk.text.length;
    let cursor = chunkStart;
    let safeText = "";
    for (const span of tokenSpans) {
      if (span.end <= chunkStart || span.start >= chunkEnd) continue;
      safeText += joined.slice(cursor, Math.max(cursor, span.start));
      if (span.start >= chunkStart) safeText += "<REDACTED>";
      cursor = Math.max(cursor, Math.min(chunkEnd, span.end));
    }
    safeText += joined.slice(cursor, chunkEnd);
    chunkStart = chunkEnd;
    return { text: safeText, stream: chunk.stream };
  });

  const redactedChunks = tokenRedactedChunks.map(() => "");
  const streamGroups = new Map<NodeJS.WriteStream, { text: string; lastIndex: number }>();
  for (const [index, chunk] of tokenRedactedChunks.entries()) {
    const group = streamGroups.get(chunk.stream);
    streamGroups.set(chunk.stream, {
      text: `${group?.text ?? ""}${chunk.text}`,
      lastIndex: index,
    });
  }
  for (const group of streamGroups.values()) {
    redactedChunks[group.lastIndex] = redactHfDownloadOutput(group.text, null);
  }
  return redactedChunks;
}

/**
 * Run `hf download` in a caller-supplied image that Docker already has.
 * Reuse the configured Hugging Face cache.
 */
export function acquireHuggingFaceModel(
  request: HuggingFaceModelAcquisitionRequest,
  observer: HuggingFaceModelAcquisitionObserver,
): Promise<HuggingFaceModelAcquisitionResult> {
  return new Promise((resolve) => {
    const credentialEnv = request.credentialEnv ?? process.env;
    const tokenValue = pickHfTokenEntry(credentialEnv)?.value ?? null;
    const containerName = `nemoclaw-hf-download-${randomUUID()}`;
    let argv: string[];
    try {
      argv = buildHuggingFaceModelDownloadArgv(request, containerName);
    } catch (err) {
      resolve({
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    observer.logLine(`Pre-downloading model with hf: ${request.repository}`);

    let proc: ReturnType<typeof spawn>;
    try {
      proc = request.spawnDocker(argv, {
        env: { ...request.dockerEnv, ...buildHfTokenForwardEnv(credentialEnv) },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        ok: false,
        reason: `spawn error: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const tail: string[] = [];
    const outputDecoders = [
      { decoder: new StringDecoder("utf8"), stream: process.stdout },
      { decoder: new StringDecoder("utf8"), stream: process.stderr },
    ];
    let pendingOutput: { text: string; stream: NodeJS.WriteStream }[] = [];
    let pendingOutputChars = 0;
    const suppressedOutputStreams = new Set<NodeJS.WriteStream>();
    let reportedOutputSuppression = false;
    let resolved = false;
    let stallCleanupInProgress = false;
    let decodersFinalized = false;
    const start = Date.now();
    let lastOutputAt = start;
    let lastOutputEndedCleanly = true;
    const stallTimeoutMs = modelDownloadStallTimeoutMs();
    const heartbeat = setInterval(() => {
      const now = Date.now();
      if (now - lastOutputAt < MODEL_DOWNLOAD_HEARTBEAT_MS) return;
      if (!lastOutputEndedCleanly) process.stdout.write("\n");
      observer.logLine(
        `Model download still running (${formatElapsed(now - start)} elapsed; no new output)`,
      );
      lastOutputEndedCleanly = true;
    }, MODEL_DOWNLOAD_HEARTBEAT_MS);
    heartbeat.unref?.();

    let stallTimer: ReturnType<typeof setTimeout>;

    function scheduleStallTimeout(): void {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (resolved || stallCleanupInProgress) return;
        stallCleanupInProgress = true;
        clearInterval(heartbeat);
        const idleMs = Date.now() - lastOutputAt;
        if (!lastOutputEndedCleanly) process.stdout.write("\n");
        observer.logLine(
          `Model download stalled: no output for ${formatElapsed(idleMs)}; aborting`,
        );
        finalizeOutputDecoders();
        void cleanupStalledDownload().then(({ containerRemoved, clientExited }) => {
          const cleanup = containerRemoved && clientExited
            ? ""
            : `; cleanup unconfirmed for container ${containerName} on Docker endpoint ${dockerEndpointIdentity(request.dockerEnv)}; select that endpoint, run docker rm --force ${containerName}, and resume onboarding only after removal is confirmed`;
          done({
            ok: false,
            reason: `hf download stalled: no output for ${formatElapsed(idleMs)}${cleanup}`,
          });
        });
      }, stallTimeoutMs);
      stallTimer.unref?.();
    }

    scheduleStallTimeout();

    async function cleanupStalledDownload(): Promise<{
      containerRemoved: boolean;
      clientExited: boolean;
    }> {
      const [containerRemoved, clientExited] = await Promise.all([
        removeStalledContainer(),
        terminateDownloadClient(),
      ]);
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      proc.unref();
      return { containerRemoved, clientExited };
    }

    function removeStalledContainer(): Promise<boolean> {
      return new Promise((resolveRemoval) => {
        let cleanupProc: ReturnType<typeof spawn>;
        try {
          cleanupProc = request.spawnDocker(["rm", "--force", containerName], {
            env: { ...request.dockerEnv },
            stdio: "ignore",
          });
        } catch {
          resolveRemoval(false);
          return;
        }
        let settled = false;
        const cleanupTimer = setTimeout(() => {
          cleanupProc.kill("SIGKILL");
          finish(false);
        }, CONTAINER_CLEANUP_TIMEOUT_MS);
        cleanupTimer.unref?.();
        const finish = (removed: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(cleanupTimer);
          cleanupProc.removeAllListeners();
          cleanupProc.unref();
          resolveRemoval(removed);
        };
        cleanupProc.once("error", () => finish(false));
        cleanupProc.once("exit", (code) => finish(code === 0));
      });
    }

    function terminateDownloadClient(): Promise<boolean> {
      return new Promise((resolveTermination) => {
        let settled = false;
        let forceTimer: NodeJS.Timeout | undefined;
        let terminalTimer: NodeJS.Timeout | undefined;
        const finish = (exited: boolean): void => {
          if (settled) return;
          settled = true;
          if (forceTimer !== undefined) clearTimeout(forceTimer);
          if (terminalTimer !== undefined) clearTimeout(terminalTimer);
          proc.off("error", failed);
          proc.off("exit", confirmed);
          resolveTermination(exited);
        };
        const failed = (): void => finish(false);
        const confirmed = (): void => finish(true);
        proc.once("error", failed);
        proc.once("exit", confirmed);
        forceTimer = setTimeout(() => {
          if (!proc.kill("SIGKILL")) {
            finish(false);
            return;
          }
          if (settled) return;
          terminalTimer = setTimeout(() => finish(false), 5_000);
          terminalTimer.unref?.();
        }, 5_000);
        forceTimer.unref?.();
        if (!proc.kill("SIGTERM")) finish(false);
      });
    }

    function done(result: HuggingFaceModelAcquisitionResult): void {
      if (resolved) return;
      resolved = true;
      clearInterval(heartbeat);
      clearTimeout(stallTimer);
      resolve(result);
    }

    function rememberTail(text: string): void {
      for (const segment of text.split(/[\r\n]+/)) {
        if (!segment) continue;
        tail.push(segment);
        if (tail.length > TAIL_MAX) tail.shift();
      }
    }

    function pendingStreamsEndCleanly(): boolean {
      const streamText = new Map<NodeJS.WriteStream, string>();
      for (const chunk of pendingOutput) {
        streamText.set(chunk.stream, `${streamText.get(chunk.stream) ?? ""}${chunk.text}`);
      }
      return [...streamText.values()].every(
        (text) => /[\r\n]$/.test(text) && !HF_SENSITIVE_HEADER_AT_STREAM_BOUNDARY.test(text),
      );
    }

    function flushOutput(flushAll = false): void {
      if (pendingOutput.length === 0 || (!flushAll && !pendingStreamsEndCleanly())) return;
      const selected = pendingOutput;
      pendingOutput = [];
      pendingOutputChars = 0;
      const safeChunks = redactHfDownloadOutputChunks(selected, tokenValue);
      for (const [index, safeText] of safeChunks.entries()) {
        if (!safeText) continue;
        selected[index].stream.write(safeText);
        lastOutputEndedCleanly = /[\r\n]$/.test(safeText);
        rememberTail(safeText);
      }
    }

    function queueOutput(text: string, stream: NodeJS.WriteStream): void {
      if (!text || suppressedOutputStreams.has(stream)) return;
      pendingOutput.push({ text, stream });
      pendingOutputChars += text.length;
      flushOutput();
      if (pendingOutputChars <= HF_PENDING_OUTPUT_MAX_CHARS) return;

      for (const chunk of pendingOutput) suppressedOutputStreams.add(chunk.stream);
      pendingOutput = [];
      pendingOutputChars = 0;
      if (!reportedOutputSuppression) {
        reportedOutputSuppression = true;
        observer.logLine(
          "Hugging Face output suppressed after exceeding the redaction buffer limit",
        );
      }
    }

    function finalizeOutputDecoders(): void {
      if (decodersFinalized) return;
      decodersFinalized = true;
      for (const state of outputDecoders) {
        const text = state.decoder.end();
        queueOutput(text, state.stream);
      }
      flushOutput(true);
    }

    function onChunk(buf: Buffer, state: (typeof outputDecoders)[number]): void {
      if (resolved || stallCleanupInProgress) return;
      lastOutputAt = Date.now();
      scheduleStallTimeout();
      const text = state.decoder.write(buf);
      queueOutput(text, state.stream);
    }

    proc.stdout?.on("data", (buf: Buffer) => onChunk(buf, outputDecoders[0]));
    proc.stderr?.on("data", (buf: Buffer) => onChunk(buf, outputDecoders[1]));

    proc.on("error", (err: Error) => {
      if (stallCleanupInProgress) return;
      finalizeOutputDecoders();
      done({ ok: false, reason: `spawn error: ${err.message}` });
    });

    proc.on("exit", (code: number | null) => {
      if (resolved || stallCleanupInProgress) return;
      finalizeOutputDecoders();
      if (code === 0) {
        if (!lastOutputEndedCleanly) process.stdout.write("\n");
        observer.logLine("Model download complete");
        done({ ok: true });
        return;
      }
      if (tail.length > 0) {
        process.stderr.write(`  --- Last ${String(tail.length)} hf output lines: ---\n`);
        for (const line of tail) process.stderr.write(`    ${line}\n`);
        process.stderr.write("  ---\n");
      }
      if (HF_RATE_LIMIT_PATTERN.test(tail.join("\n"))) observer.onRateLimit();
      done({ ok: false, reason: `hf download failed (exit ${String(code)})` });
    });
  });
}
