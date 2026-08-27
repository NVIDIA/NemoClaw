// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import { dockerCapture } from "../adapters/docker";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  DOCKER_NETWORK_IPAM_INSPECT_FORMAT,
  parseDockerNetworkIpamEntries,
  resolveDockerDriverNetworkName,
} from "../onboard/experimental/docker-network-authority";
import { requireCuaServiceEndpoints } from "./service-endpoints";

const RELAY_MARKER = "--nemoclaw-cua-service-relay";
const STATE_VERSION = 1;
const ROLES = new Set(["browser", "computer", "terminal", "fixture"]);
const READY_TIMEOUT_MS = 5_000;

type RelayEndpoint = { role: string; targetHost: string; port: number };
type RelayState = {
  version: 1;
  sandboxName: string;
  bindHost: string;
  clientHost: string;
  pid: number;
  endpoints: RelayEndpoint[];
};

function statePath(sandboxName: string, home = os.homedir()): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u.test(sandboxName)) {
    throw new Error("Invalid sandbox name for NemoCUA service relay");
  }
  return path.join(home, ".local", "state", "nemoclaw", "cua-relays", `${sandboxName}.json`);
}

/** Resolve the selected OpenShell Docker bridge listener address. */
export function resolveCuaServiceRelayBridgeAddress(
  env: NodeJS.ProcessEnv,
  capture: typeof dockerCapture = dockerCapture,
): string {
  const raw = capture(
    [
      "network",
      "inspect",
      "--format",
      DOCKER_NETWORK_IPAM_INSPECT_FORMAT,
      resolveDockerDriverNetworkName(env),
    ],
    { ignoreError: true, timeout: READY_TIMEOUT_MS },
  );
  const gateway = parseDockerNetworkIpamEntries(raw)?.find(
    ({ gatewayIp }) => gatewayIp && !gatewayIp.includes(":"),
  )?.gatewayIp;
  if (!gateway) {
    throw new Error("NemoCUA could not resolve the OpenShell bridge address for its service relay");
  }
  return gateway;
}

function exactIpv4(value: string): boolean {
  return /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(value);
}

function resolveSandboxAddress(
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  capture: typeof dockerCapture = dockerCapture,
): string {
  const networkName = resolveDockerDriverNetworkName(env);
  const address = capture(
    [
      "ps",
      "-a",
      "-q",
      "--filter",
      `label=openshell.ai/sandbox-name=${sandboxName}`,
      "--filter",
      "label=openshell.ai/managed-by=openshell",
    ],
    { ignoreError: true, timeout: READY_TIMEOUT_MS },
  )
    .split(/\s+/u)
    .filter(Boolean)
    .map((id) =>
      capture(
        [
          "inspect",
          "--format",
          `{{with index .NetworkSettings.Networks ${JSON.stringify(networkName)}}}{{.IPAddress}}{{end}}`,
          id,
        ],
        { ignoreError: true, timeout: READY_TIMEOUT_MS },
      ).trim(),
    )
    .find(exactIpv4);
  if (!address) throw new Error("NemoCUA could not verify its sandbox bridge address");
  return address;
}

function validEndpoints(value: unknown): value is RelayEndpoint[] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    new Set(value.map((endpoint) => endpoint?.role)).size === 4 &&
    value.every(
      (endpoint) =>
        endpoint !== null &&
        typeof endpoint === "object" &&
        ROLES.has((endpoint as RelayEndpoint).role) &&
        ["127.0.0.1", "localhost", "::1"].includes((endpoint as RelayEndpoint).targetHost) &&
        Number.isInteger((endpoint as RelayEndpoint).port) &&
        (endpoint as RelayEndpoint).port >= 1024 &&
        (endpoint as RelayEndpoint).port <= 65535,
    )
  );
}

function readState(file: string): RelayState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RelayState;
    return parsed.version === STATE_VERSION &&
      typeof parsed.sandboxName === "string" &&
      typeof parsed.bindHost === "string" &&
      typeof parsed.clientHost === "string" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      validEndpoints(parsed.endpoints)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function readProcessArgs(pid: number): string[] | null {
  try {
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      timeout: 2_000,
    })
      .trim()
      .split(/\s+/u);
  } catch {
    return null;
  }
}

function processOwnsRelay(state: RelayState): boolean {
  try {
    process.kill(state.pid, 0);
    const args = readProcessArgs(state.pid);
    return Boolean(args?.includes(RELAY_MARKER) && args.includes(state.sandboxName));
  } catch {
    return false;
  }
}

export function stopCuaServiceRelay(sandboxName: string, removeState = false): void {
  const file = statePath(sandboxName);
  const state = readState(file);
  if (state && processOwnsRelay(state)) {
    process.kill(state.pid, "SIGTERM");
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline && processOwnsRelay(state)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    if (processOwnsRelay(state)) {
      throw new Error("NemoCUA service relay did not stop; ownership state was preserved");
    }
  }
  if (removeState) fs.rmSync(file, { force: true });
}

function waitForReady(childPid: number, file: string): void {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readState(file);
    if (state?.pid === childPid && processOwnsRelay(state)) return;
    try {
      process.kill(childPid, 0);
    } catch {
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  try {
    process.kill(childPid, "SIGTERM");
  } catch {
    // Child already exited after a bind failure.
  }
  throw new Error("NemoCUA service relay did not bind all four bridge listeners");
}

/** Start or reconcile the bridge listeners that preserve loopback-only services. */
export function ensureCuaServiceRelay(
  sandboxName: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const file = statePath(sandboxName);
  const previous = readState(file);
  const configured = Object.keys(env).some(
    (key) => key.startsWith("NEMOCLAW_CUA_") && key.endsWith("_ENDPOINT"),
  );
  const requested = configured
    ? requireCuaServiceEndpoints(env).map(({ role, targetHost, port }) => ({
        role,
        targetHost,
        port,
      }))
    : undefined;
  if (previous && requested && JSON.stringify(previous.endpoints) !== JSON.stringify(requested)) {
    throw new Error("NemoCUA service endpoints differ from the sandbox relay state");
  }
  const endpoints = previous?.endpoints ?? requested;
  if (!validEndpoints(endpoints)) {
    throw new Error(
      "NemoCUA service relay state is missing; rerun onboarding with all endpoint inputs",
    );
  }
  const bindHost = resolveCuaServiceRelayBridgeAddress(env);
  const clientHost = resolveSandboxAddress(sandboxName, env);
  if (
    previous &&
    processOwnsRelay(previous) &&
    previous.bindHost === bindHost &&
    previous.clientHost === clientHost
  )
    return;
  if (previous) stopCuaServiceRelay(sandboxName);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const child = spawn(
    process.execPath,
    [
      __filename,
      RELAY_MARKER,
      sandboxName,
      bindHost,
      Buffer.from(JSON.stringify(endpoints)).toString("base64url"),
      file,
      clientHost,
    ],
    { detached: true, stdio: "ignore" },
  );
  if (!child.pid) throw new Error("NemoCUA service relay did not return a process ID");
  try {
    waitForReady(child.pid, file);
    try {
      process.kill(child.pid, 0);
    } catch {
      throw new Error("NemoCUA service relay exited after listener readiness");
    }
    child.unref();
  } catch (error) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {
      // Child already exited after a bind or state-write failure.
    }
    if (!readState(file)) fs.rmSync(file, { force: true });
    throw error;
  }
}

export async function runCuaServiceRelay(
  bindHost: string,
  endpoints: RelayEndpoint[],
  stateFile?: string,
  state?: Omit<RelayState, "pid">,
): Promise<net.Server[]> {
  if (!validEndpoints(endpoints)) throw new Error("Invalid NemoCUA relay endpoint descriptor");
  const servers = endpoints.map((endpoint) => {
    const server = net.createServer((client) => {
      if (state && client.remoteAddress !== state.clientHost) {
        client.destroy();
        return;
      }
      const upstream = net.connect(endpoint.port, endpoint.targetHost);
      client.pipe(upstream).pipe(client);
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    return server;
  });
  try {
    for (const [index, server] of servers.entries()) {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(endpoints[index]?.port, bindHost, resolve);
      });
    }
    if (stateFile && state) {
      const temporary = `${stateFile}.${String(process.pid)}.tmp`;
      try {
        fs.writeFileSync(temporary, `${JSON.stringify({ ...state, pid: process.pid })}\n`, {
          mode: 0o600,
        });
        fs.renameSync(temporary, stateFile);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    }
    return servers;
  } catch (error) {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server.listening) return resolve();
            server.close(() => resolve());
          }),
      ),
    );
    throw error;
  }
}

if (process.argv[2] === RELAY_MARKER) {
  const endpoints = JSON.parse(
    Buffer.from(process.argv[5] ?? "", "base64url").toString("utf8"),
  ) as RelayEndpoint[];
  void runCuaServiceRelay(process.argv[4] as string, endpoints, process.argv[6] as string, {
    version: STATE_VERSION,
    sandboxName: process.argv[3] as string,
    bindHost: process.argv[4] as string,
    clientHost: process.argv[7] as string,
    endpoints,
  }).catch(() => process.exit(1));
}
