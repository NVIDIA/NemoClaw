// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

const { envInt }: typeof import("./env") = require("./env");
const { ROOT } = require("../runner") as typeof import("../runner");

/** Spawn `openshell gateway start` and stream its output with progress heartbeats. */
export function streamGatewayStart(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ status: number; output: string }> {
  const child = spawn("bash", ["-lc", command], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines: string[] = [];
  let pending = "";
  let settled = false;
  let resolvePromise: (value: { status: number; output: string }) => void;
  let lastPrintedLine = "";
  let currentPhase = "cluster";
  let lastHeartbeatBucket = -1;
  let lastOutputAt = Date.now();
  const startedAt = Date.now();

  function getDisplayWidth(): number {
    return Math.max(60, Number(process.stdout.columns || 100));
  }

  function trimDisplayLine(line: string): string {
    const width = getDisplayWidth();
    const maxLen = Math.max(40, width - 4);
    if (line.length <= maxLen) return line;
    return `${line.slice(0, Math.max(0, maxLen - 3))}...`;
  }

  function printProgressLine(line: string): void {
    const display = trimDisplayLine(line);
    if (display !== lastPrintedLine) {
      console.log(display);
      lastPrintedLine = display;
    }
  }

  function elapsedSeconds(): number {
    return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  }

  function setPhase(nextPhase: string | null): void {
    if (!nextPhase || nextPhase === currentPhase) return;
    currentPhase = nextPhase;
    const phaseLine =
      nextPhase === "install"
        ? "  Installing OpenShell components..."
        : nextPhase === "pod"
          ? "  Starting OpenShell gateway pod..."
          : nextPhase === "health"
            ? "  Waiting for gateway health..."
            : "  Starting gateway cluster...";
    printProgressLine(phaseLine);
  }

  function classifyLine(line: string): string | null {
    if (/ApplyJob|helm-install-openshell|Applying HelmChart/i.test(line)) return "install";
    if (
      /openshell-0|Observed pod startup duration|MountVolume\.MountDevice succeeded/i.test(line)
    ) {
      return "pod";
    }
    if (/Gateway .* ready\.?$/i.test(line)) return "health";
    return null;
  }

  function flushLine(rawLine: string): void {
    const line = rawLine.replace(/\r/g, "").trimEnd();
    if (!line) return;
    lines.push(line);
    lastOutputAt = Date.now();
    const nextPhase = classifyLine(line);
    if (nextPhase) setPhase(nextPhase);
  }

  function onChunk(chunk: Buffer | string): void {
    pending += chunk.toString();
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    parts.forEach(flushLine);
  }

  function finish(result: { status: number; output: string }): void {
    if (settled) return;
    settled = true;
    if (pending) flushLine(pending);
    clearInterval(heartbeatTimer);
    resolvePromise(result);
  }

  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  printProgressLine("  Starting gateway cluster...");
  const heartbeatTimer = setInterval(() => {
    if (settled) return;
    const elapsed = elapsedSeconds();
    const bucket = Math.floor(elapsed / 10);
    if (bucket === lastHeartbeatBucket) return;
    if (Date.now() - lastOutputAt < 3000 && elapsed < 10) return;
    const heartbeatLine =
      currentPhase === "install"
        ? `  Still installing OpenShell components... (${elapsed}s elapsed)`
        : currentPhase === "pod"
          ? `  Still starting OpenShell gateway pod... (${elapsed}s elapsed)`
          : currentPhase === "health"
            ? `  Still waiting for gateway health... (${elapsed}s elapsed)`
            : `  Still starting gateway cluster... (${elapsed}s elapsed)`;
    printProgressLine(heartbeatLine);
    lastHeartbeatBucket = bucket;
  }, 5000);
  heartbeatTimer.unref?.();

  // Hard timeout to prevent indefinite hangs if the openshell process
  // never exits (e.g. Docker daemon unresponsive, k3s restart loop). (#1830)
  // On timeout, send SIGTERM and let the `close` event resolve the promise
  // so the child has actually exited before the caller proceeds to retry.
  const gatewayStartTimeout = envInt("NEMOCLAW_GATEWAY_START_TIMEOUT", 600) * 1000;
  let killedByTimeout = false;
  const killTimer = setTimeout(() => {
    killedByTimeout = true;
    lines.push("[NemoClaw] Gateway start timed out - killing process.");
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, 10_000).unref?.();
  }, gatewayStartTimeout);
  killTimer.unref?.();

  return new Promise<{ status: number; output: string }>((resolve) => {
    resolvePromise = resolve;
    child.on("error", (error: Error) => {
      clearTimeout(killTimer);
      const detail = error?.message || String(error);
      lines.push(detail);
      finish({ status: 1, output: lines.join("\n") });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(killTimer);
      const exitCode = killedByTimeout ? 1 : (code ?? 1);
      finish({ status: exitCode, output: lines.join("\n") });
    });
  });
}
