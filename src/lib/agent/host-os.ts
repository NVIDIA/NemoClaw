// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isWsl } from "../core/wsl";
import type { ManifestRecord } from "./definition-types";

export const AGENT_HOST_OS_VALUES = ["linux", "macos", "wsl", "windows"] as const;

/** `linux` is a native Linux host; a WSL host is `wsl`. */
export type AgentHostOs = (typeof AGENT_HOST_OS_VALUES)[number];

const HOST_OS_NAMES: Readonly<Record<AgentHostOs, string>> = {
  linux: "native Linux",
  macos: "macOS",
  wsl: "WSL",
  windows: "Windows",
};

function isAgentHostOs(value: unknown): value is AgentHostOs {
  return typeof value === "string" && (AGENT_HOST_OS_VALUES as readonly string[]).includes(value);
}

/** Read the host operating systems an agent is qualified on; absence means every host. */
export function readHostOs(record: ManifestRecord): readonly AgentHostOs[] | null {
  const value = record.host_os;
  if (value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(isAgentHostOs) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(
      `Agent manifest field 'host_os' must list distinct values from: ${AGENT_HOST_OS_VALUES.join(", ")}`,
    );
  }
  return Object.freeze([...value]);
}

export interface AgentHostOsDetectionOptions {
  readonly platform?: NodeJS.Platform;
  readonly isWsl?: boolean;
}

export function detectAgentHostOs(options: AgentHostOsDetectionOptions = {}): AgentHostOs | null {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  if (platform !== "linux") return null;
  return (options.isWsl ?? isWsl()) ? "wsl" : "linux";
}

/** Refuse an agent on a host operating system that its manifest does not qualify. */
export function requireAgentHostOsSupported(
  agent: { readonly name: string; readonly hostOs?: readonly AgentHostOs[] | null },
  host: AgentHostOs | null = detectAgentHostOs(),
): void {
  const qualified = agent.hostOs ?? null;
  if (qualified === null || (host !== null && qualified.includes(host))) return;
  const supported = qualified.map((value) => HOST_OS_NAMES[value]).join(" or ");
  const detected = host === null ? "an unrecognized operating system" : HOST_OS_NAMES[host];
  throw new Error(
    `Agent '${agent.name}' is supported only on ${supported} hosts; this host is ${detected}.`,
  );
}
