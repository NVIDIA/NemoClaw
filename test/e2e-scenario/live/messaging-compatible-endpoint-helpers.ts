// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");

export function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    ...extra,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Best-effort cleanup mirrors the legacy shell teardown.
    // Narrow this once NemoClaw/OpenShell/gateway teardown treats missing
    // resources as successful cleanup.
  }
}

export async function stopGatewayRuntime(host: HostCliClient, artifactName: string): Promise<void> {
  await bestEffort(() =>
    host.command(
      "bash",
      [
        "-lc",
        [
          "set +e",
          "openshell forward stop 18789 >/dev/null 2>&1",
          "openshell gateway stop -g nemoclaw >/dev/null 2>&1",
          'pid_file="$HOME/.local/state/nemoclaw/openshell-docker-gateway/openshell-gateway.pid"',
          'if [ -f "$pid_file" ]; then',
          '  pid="$(tr -d "[:space:]" <"$pid_file" 2>/dev/null || true)"',
          '  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then',
          '    kill "$pid" 2>/dev/null || true',
          "    for _ in $(seq 1 10); do",
          '      kill -0 "$pid" 2>/dev/null || break',
          "      sleep 1",
          "    done",
          '    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true',
          "  fi",
          "fi",
          'cid="$(docker ps -qf "name=openshell-cluster-nemoclaw" 2>/dev/null | head -1)"',
          'if [ -n "$cid" ]; then docker stop "$cid" >/dev/null 2>&1 || true; fi',
          "openshell gateway remove nemoclaw >/dev/null 2>&1",
          "openshell gateway destroy -g nemoclaw >/dev/null 2>&1",
          "exit 0",
        ].join("\n"),
      ],
      {
        artifactName,
        env: commandEnv(),
        timeoutMs: 90_000,
      },
    ),
  );
}

export async function cleanupMessagingState(
  host: HostCliClient,
  sandboxName: string,
): Promise<void> {
  // Endpoint-validation skips can happen before the sandbox exists. Keep
  // teardown non-throwing so "Sandbox ... does not exist" stays a normal
  // pre-contract cleanup outcome instead of masking the original evidence.
  await bestEffort(() =>
    host.command("node", [CLI_ENTRYPOINT, sandboxName, "destroy", "--yes"], {
      artifactName: `cleanup-nemoclaw-destroy-${sandboxName}`,
      env: commandEnv(),
      timeoutMs: 120_000,
    }),
  );
  await bestEffort(() =>
    host.command("openshell", ["sandbox", "delete", sandboxName], {
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
