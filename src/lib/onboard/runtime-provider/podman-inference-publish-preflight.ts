// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { isPortBoundOnHost, probePortBoundSync } from "../dashboard-port";

export type OccupiedInferencePublish = {
  readonly address: string;
  readonly port: number;
  readonly process: string;
  readonly pid: number | null;
};

export type InspectPublishedPort = (
  address: string,
  port: number,
) => OccupiedInferencePublish | null;

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/u;

export function occupiedInferencePublishMessage(hit: OccupiedInferencePublish): string {
  const owner = hit.pid === null ? hit.process : `${hit.process} (PID ${String(hit.pid)})`;
  const processName = hit.process.toLowerCase();
  let nextStep =
    "Stop that listener or the leftover NemoClaw Podman Ollama container (uninstall or destroy the owning sandbox), then rerun onboarding.";
  if (processName === "ollama" || processName.startsWith("ollama-")) {
    nextStep =
      "Portable onboarding starts its own Podman Ollama and does not reuse a host Ollama process. Stop that host service, then rerun onboarding.";
  } else if (processName === "unknown") {
    nextStep =
      "Stop a host Ollama service or leftover Portable Ollama container on that port, then rerun onboarding.";
  }
  return `Port ${String(hit.port)} on ${hit.address} is already in use by ${owner}. ${nextStep}`;
}

export function publishedInferenceHostBindings(
  port: number,
  listenerIp: string,
): readonly { readonly address: string; readonly port: number }[] {
  const loopback = Object.freeze({ address: "127.0.0.1", port });
  return listenerIp === "127.0.0.1"
    ? Object.freeze([loopback])
    : Object.freeze([loopback, Object.freeze({ address: listenerIp, port })]);
}

export function firstOccupiedInferencePublish(
  bindings: readonly { readonly address: string; readonly port: number }[],
  inspect: InspectPublishedPort,
): OccupiedInferencePublish | null {
  for (const binding of bindings) {
    const hit = inspect(binding.address, binding.port);
    if (hit) return hit;
  }
  return null;
}

export function lsofListenArguments(address: string, port: number): readonly string[] {
  return Object.freeze(["-nP", `-iTCP@${address}:${String(port)}`, "-sTCP:LISTEN"]);
}

export function lsofListenerArgvCandidates(
  address: string,
  port: number,
): readonly (readonly string[])[] {
  const args = lsofListenArguments(address, port);
  return Object.freeze([
    Object.freeze(["/usr/bin/lsof", ...args]),
    Object.freeze(["/usr/bin/sudo", "-n", "/usr/bin/lsof", ...args]),
  ]);
}

export function parseLsofListener(
  output: string,
  address: string,
  port: number,
): OccupiedInferencePublish | null {
  const dataLine = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("COMMAND"));
  if (!dataLine) return null;
  const parts = dataLine.split(/\s+/u);
  const process = parts[0];
  if (!process) return null;
  const parsedPid = Number(parts[1]);
  return Object.freeze({
    address,
    port,
    process,
    pid: Number.isSafeInteger(parsedPid) && parsedPid > 0 ? parsedPid : null,
  });
}

function publishInspectTargetValid(address: string, port: number): boolean {
  return IPV4.test(address) && Number.isInteger(port) && port > 0 && port <= 65_535;
}

function lsofListener(address: string, port: number): OccupiedInferencePublish | null {
  if (!publishInspectTargetValid(address, port)) return null;
  for (const argv of lsofListenerArgvCandidates(address, port)) {
    const result = spawnSync(argv[0]!, argv.slice(1), {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || (result.status !== 0 && result.status !== 1)) continue;
    const parsed = parseLsofListener(String(result.stdout ?? ""), address, port);
    if (parsed) return parsed;
  }
  return null;
}

export function occupiedFromBindProbeStatus(
  status: number | null,
  address: string,
  port: number,
): boolean {
  if (status === 0) return false;
  if (status === 1) return true;
  throw new Error(`Cannot bind the inference publish target ${address}:${String(port)}.`);
}

function probePortBoundOnAddress(address: string, port: number): boolean {
  if (!IPV4.test(address) || !Number.isInteger(port) || port <= 0 || port > 65_535) return false;
  if (address === "127.0.0.1") return probePortBoundSync(port);
  const script =
    "const net = require('node:net');" +
    "const srv = net.createServer();" +
    "let done = false;" +
    "const exit = (code) => { if (!done) { done = true; process.exit(code); } };" +
    "srv.once('error', (e) => exit(e && e.code === 'EADDRINUSE' ? 1 : 2));" +
    `srv.listen(${String(port)}, ${JSON.stringify(address)}, () => srv.close(() => exit(0)));`;
  const result = spawnSync(process.execPath, ["-e", script], {
    stdio: "ignore",
    timeout: 2_000,
  });
  if (result.error) {
    throw new Error(`Cannot bind the inference publish target ${address}:${String(port)}.`);
  }
  return occupiedFromBindProbeStatus(result.status, address, port);
}

export function inspectHostInferencePublish(
  address: string,
  port: number,
): OccupiedInferencePublish | null {
  // Unit tests mock Podman and must not depend on the developer host listener.
  if (process.env.VITEST) return null;
  const named = lsofListener(address, port);
  if (named) return named;
  const bound =
    address === "127.0.0.1" ? isPortBoundOnHost(port) : probePortBoundOnAddress(address, port);
  return bound ? Object.freeze({ address, port, process: "unknown", pid: null }) : null;
}

export function assertInferencePublishPortsFree(
  port: number,
  listenerIp: string,
  inspect: InspectPublishedPort = inspectHostInferencePublish,
): void {
  const occupied = firstOccupiedInferencePublish(
    publishedInferenceHostBindings(port, listenerIp),
    inspect,
  );
  if (!occupied) return;
  throw new Error(occupiedInferencePublishMessage(occupied));
}
