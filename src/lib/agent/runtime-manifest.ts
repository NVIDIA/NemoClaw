// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type AgentRuntimeKind = "gateway" | "terminal";

export interface AgentRuntime {
  kind: AgentRuntimeKind;
  interactive_command?: string;
  headless_command?: string;
  smoke_commands?: string[];
}

type RuntimeRecord = { [key: string]: unknown };

function isRecord(value: unknown): value is RuntimeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: RuntimeRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readStringArray(record: RuntimeRecord, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  if (value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Agent manifest field 'runtime.${key}' must be an array of strings`);
  }
  return value as string[];
}

export function readAgentRuntime(record: RuntimeRecord): AgentRuntime {
  const runtime = record.runtime;
  if (!isRecord(runtime)) return { kind: "gateway" };

  const rawKind = runtime.kind;
  if (rawKind !== undefined && rawKind !== "gateway" && rawKind !== "terminal") {
    throw new Error("Agent manifest field 'runtime.kind' must be gateway or terminal");
  }

  const kind: AgentRuntimeKind = rawKind === "terminal" ? "terminal" : "gateway";
  const interactiveCommand = readString(runtime, "interactive_command")?.trim();
  const headlessCommand = readString(runtime, "headless_command")?.trim();
  const smokeCommands = readStringArray(runtime, "smoke_commands");

  if (kind === "terminal" && !interactiveCommand && !headlessCommand) {
    throw new Error(
      "Agent manifest field 'runtime' must define interactive_command or headless_command for terminal agents",
    );
  }

  return {
    kind,
    ...(interactiveCommand ? { interactive_command: interactiveCommand } : {}),
    ...(headlessCommand ? { headless_command: headlessCommand } : {}),
    ...(smokeCommands && smokeCommands.length > 0 ? { smoke_commands: smokeCommands } : {}),
  };
}

export function getAgentRuntimeKind(
  agent: { runtime?: { kind?: unknown } | null } | null | undefined,
): AgentRuntimeKind {
  return agent?.runtime?.kind === "terminal" ? "terminal" : "gateway";
}

export function isTerminalAgent(
  agent: { runtime?: { kind?: unknown } | null } | null | undefined,
): boolean {
  return getAgentRuntimeKind(agent) === "terminal";
}
