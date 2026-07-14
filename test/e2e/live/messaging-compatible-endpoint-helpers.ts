// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { resolveGatewayPortFromName } from "../../../src/lib/onboard/gateway-binding.ts";
import {
  hostGatewayCmdlineMatches,
  resolveDockerDriverGatewayPidFile,
} from "../../../src/lib/onboard/host-gateway-process.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { CLI_ENTRYPOINT } from "../fixtures/paths.ts";

export function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
}

async function preCleanBestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Best-effort cleanup mirrors the former shell teardown.
    // Narrow this once NemoClaw/OpenShell/gateway teardown treats missing
    // resources as successful cleanup.
  }
}

const GATEWAY_NAME = "nemoclaw";
const GATEWAY_PORT = resolveGatewayPortFromName(GATEWAY_NAME);

type GatewayPidState =
  | { kind: "absent" }
  | { kind: "unverified" }
  | { kind: "owned"; startTime: string };

type GatewayPidFileState = { kind: "absent" } | { kind: "invalid" } | { kind: "pid"; pid: number };

function readGatewayPid(): GatewayPidFileState {
  try {
    const raw = fs.readFileSync(resolveDockerDriverGatewayPidFile(), "utf8").trim();
    if (!/^\d+$/u.test(raw)) return { kind: "invalid" };
    const pid = Number(raw);
    return Number.isSafeInteger(pid) && pid > 0 ? { kind: "pid", pid } : { kind: "invalid" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "invalid" };
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

function readProcessSnapshot(pid: number): { cmdline: string; startTime: string } | null {
  if (process.platform === "linux") {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    const fields =
      commandEnd >= 0
        ? stat
            .slice(commandEnd + 2)
            .trim()
            .split(/\s+/u)
        : [];
    const startTime = fields[19];
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
    return startTime ? { cmdline, startTime } : null;
  }
  if (process.platform === "darwin") {
    const line = execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
      encoding: "utf8",
    }).trim();
    if (line.length <= 24) return null;
    return { cmdline: line.slice(24).trim(), startTime: line.slice(0, 24) };
  }
  return null;
}

function inspectGatewayPid(pid: number): GatewayPidState {
  if (!processExists(pid)) return { kind: "absent" };
  try {
    const snapshot = readProcessSnapshot(pid);
    if (
      !snapshot ||
      !hostGatewayCmdlineMatches(snapshot.cmdline, undefined, {
        name: GATEWAY_NAME,
        port: GATEWAY_PORT,
      })
    ) {
      return { kind: "unverified" };
    }
    return { kind: "owned", startTime: snapshot.startTime };
  } catch {
    return processExists(pid) ? { kind: "unverified" } : { kind: "absent" };
  }
}

async function waitForOriginalGatewayExit(
  pid: number,
  startTime: string,
  timeoutMs: number,
): Promise<GatewayPidState> {
  const deadline = Date.now() + timeoutMs;
  let state = inspectGatewayPid(pid);
  while (Date.now() < deadline) {
    if (state.kind === "absent") return state;
    if (state.kind === "owned" && state.startTime !== startTime) return state;
    await sleep(100);
    state = inspectGatewayPid(pid);
  }
  return state;
}

function signalOriginalGateway(
  pid: number,
  startTime: string,
  signal: NodeJS.Signals,
  strict: boolean,
): boolean {
  const current = inspectGatewayPid(pid);
  if (current.kind === "absent") return false;
  if (current.kind === "owned" && current.startTime !== startTime) return false;
  if (current.kind === "unverified") {
    if (strict)
      throw new Error(`Refusing ${signal} because gateway process ${pid} is no longer owned`);
    return false;
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if (strict) throw error;
    return false;
  }
}

async function stopOwnedGatewayPid(strict: boolean): Promise<void> {
  const pidFile = readGatewayPid();
  if (pidFile.kind === "absent") return;
  if (pidFile.kind === "invalid") {
    if (strict)
      throw new Error("Refusing cleanup because the gateway PID file is invalid or unreadable");
    return;
  }
  const { pid } = pidFile;
  const initial = inspectGatewayPid(pid);
  if (initial.kind === "absent") return;
  if (initial.kind === "unverified") {
    if (strict) {
      throw new Error(
        `Refusing cleanup because PID-file process ${pid} does not prove ownership of gateway '${GATEWAY_NAME}'`,
      );
    }
    return;
  }

  if (!signalOriginalGateway(pid, initial.startTime, "SIGTERM", strict)) return;
  const afterTerm = await waitForOriginalGatewayExit(pid, initial.startTime, 10_000);
  if (afterTerm.kind === "absent") return;
  if (afterTerm.kind === "owned" && afterTerm.startTime !== initial.startTime) return;
  if (afterTerm.kind === "unverified") {
    if (strict) throw new Error(`Could not verify gateway process ${pid} after SIGTERM`);
    return;
  }

  if (!signalOriginalGateway(pid, initial.startTime, "SIGKILL", strict)) return;
  const afterKill = await waitForOriginalGatewayExit(pid, initial.startTime, 5_000);
  if (afterKill.kind === "absent") return;
  if (afterKill.kind === "owned" && afterKill.startTime !== initial.startTime) return;
  if (strict) throw new Error(`Owned gateway process ${pid} did not stop`);
}

export async function cleanupOwnedGatewayRuntimeStrict(
  host: HostCliClient,
  artifactName: string,
): Promise<void> {
  await stopOwnedGatewayPid(true);
  const result = await host.command(
    "bash",
    [
      "-lc",
      [
        "set -uo pipefail",
        'cid="$(docker ps -qf "name=openshell-cluster-nemoclaw" | head -1)" || exit $?',
        'if [ -n "$cid" ]; then docker stop "$cid" >/dev/null; fi',
      ].join("\n"),
    ],
    {
      artifactName,
      env: commandEnv(),
      timeoutMs: 90_000,
    },
  );
  assertExitZero(result, "cleanup messaging-compatible owned gateway runtime");
}

export async function stopGatewayRuntime(host: HostCliClient, artifactName: string): Promise<void> {
  await preCleanBestEffort(() =>
    host.command(
      "bash",
      [
        "-lc",
        [
          "set +e",
          'openshell_bin="$1"',
          '"$openshell_bin" forward stop 18789 >/dev/null 2>&1',
          '"$openshell_bin" gateway stop -g nemoclaw >/dev/null 2>&1',
          'cid="$(docker ps -qf "name=openshell-cluster-nemoclaw" 2>/dev/null | head -1)"',
          'if [ -n "$cid" ]; then docker stop "$cid" >/dev/null 2>&1 || true; fi',
          '"$openshell_bin" gateway remove nemoclaw >/dev/null 2>&1',
          '"$openshell_bin" gateway destroy -g nemoclaw >/dev/null 2>&1',
          "exit 0",
        ].join("\n"),
        "gateway-runtime-preclean",
        host.openshellCommandPath,
      ],
      {
        artifactName,
        env: commandEnv(),
        timeoutMs: 90_000,
      },
    ),
  );
  await stopOwnedGatewayPid(false);
}

export async function cleanupMessagingState(
  host: HostCliClient,
  sandboxName: string,
): Promise<void> {
  // Endpoint-validation skips can happen before the sandbox exists. Keep
  // teardown non-throwing so "Sandbox ... does not exist" stays a normal
  // pre-contract cleanup outcome instead of masking the original evidence.
  await preCleanBestEffort(() =>
    host.command("node", [CLI_ENTRYPOINT, sandboxName, "destroy", "--yes"], {
      artifactName: `cleanup-nemoclaw-destroy-${sandboxName}`,
      env: commandEnv(),
      timeoutMs: 120_000,
    }),
  );
  await preCleanBestEffort(() =>
    host.command(host.openshellCommandPath, ["sandbox", "delete", sandboxName], {
      artifactName: `cleanup-openshell-sandbox-delete-${sandboxName}`,
      env: commandEnv(),
      timeoutMs: 60_000,
    }),
  );
  await stopGatewayRuntime(host, "cleanup-openshell-gateway-runtime-nemoclaw");
}

function findJsonObjectEnd(raw: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

export function parseOpenClawAgentText(raw: string): string {
  if (!raw.trim()) return "";
  const parts: string[] = [];
  const visited = new Set<unknown>();
  const textKeys = new Set(["text", "content", "reasoning_content"]);
  const containerKeys = new Set([
    "result",
    "payloads",
    "payload",
    "messages",
    "choices",
    "response",
    "data",
    "output",
    "outputs",
    "items",
    "segments",
    "delta",
  ]);

  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
  };
  const collect = (value: unknown) => {
    if (visited.has(value)) return;
    visited.add(value);
    if (typeof value === "string") {
      add(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const key of textKeys) {
      if (key in record) collect(record[key]);
    }
    const choices = record.choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        if (!choice || typeof choice !== "object") continue;
        collect((choice as Record<string, unknown>).message);
        collect((choice as Record<string, unknown>).delta);
        add((choice as Record<string, unknown>).text);
      }
    }
    for (const key of containerKeys) {
      if (key in record) collect(record[key]);
    }
  };
  const collectDoc = (doc: unknown) => {
    if (doc && typeof doc === "object" && (doc as Record<string, unknown>).result) {
      collect((doc as Record<string, unknown>).result);
    } else {
      collect(doc);
    }
  };

  try {
    collectDoc(JSON.parse(raw));
  } catch {
    for (const match of raw.matchAll(/{/g)) {
      try {
        const before = parts.length;
        const start = match.index;
        const end = findJsonObjectEnd(raw, start);
        if (end === null) continue;
        collectDoc(JSON.parse(raw.slice(start, end)));
        if (parts.length > before) break;
      } catch {
        // Continue scanning for a later JSON object, matching the legacy parser.
      }
    }
  }
  return parts.join("\n");
}
