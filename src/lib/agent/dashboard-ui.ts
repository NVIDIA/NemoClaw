// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isTruthyEnv } from "../hermes-dashboard";
import type { AgentDefinition } from "./defs";

type ManifestRecordLike = Record<string, unknown>;

export interface AgentDashboardUi {
  label: string;
  port: number;
  path: string;
  enableEnv: string;
  portEnv: string;
  tuiEnv: string | null;
}

function readString(record: ManifestRecordLike, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readObject(record: ManifestRecordLike, key: string): ManifestRecordLike | undefined {
  const value = record[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return value as ManifestRecordLike;
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

export function readDashboardUi(record: ManifestRecordLike): AgentDashboardUi | null {
  const dashboardUi = readObject(record, "dashboard_ui");
  if (!dashboardUi) return null;

  const port = dashboardUi.port;
  if (!isValidPort(port)) {
    throw new Error(
      "Agent manifest field 'dashboard_ui.port' must be an integer TCP port between 1024 and 65535",
    );
  }

  const label = readString(dashboardUi, "label")?.trim() || "Web dashboard";
  const rawPath = readString(dashboardUi, "path")?.trim() || "/";
  const enableEnv = readString(dashboardUi, "enable_env")?.trim();
  const portEnv = readString(dashboardUi, "port_env")?.trim();
  const tuiEnv = readString(dashboardUi, "tui_env")?.trim() || null;
  if (!enableEnv) {
    throw new Error("Agent manifest field 'dashboard_ui.enable_env' is required");
  }
  if (!portEnv) {
    throw new Error("Agent manifest field 'dashboard_ui.port_env' is required");
  }

  return {
    label,
    port,
    path: rawPath.startsWith("/") ? rawPath : `/${rawPath}`,
    enableEnv,
    portEnv,
    tuiEnv,
  };
}

function dashboardUiEnabled(agent: AgentDefinition, env: NodeJS.ProcessEnv): boolean {
  const dashboardUi = agent.dashboardUi;
  return !!dashboardUi && isTruthyEnv(env[dashboardUi.enableEnv]);
}

function dashboardUiPort(agent: AgentDefinition, env: NodeJS.ProcessEnv): number {
  const dashboardUi = agent.dashboardUi;
  if (!dashboardUi) return agent.forwardPort;
  const raw = env[dashboardUi.portEnv];
  if (raw && /^\d+$/.test(raw.trim())) {
    const port = Number(raw.trim());
    if (port >= 1024 && port <= 65535) return port;
  }
  return dashboardUi.port;
}

export function printOptionalDashboardUi(
  agent: AgentDefinition,
  deps: {
    buildControlUiUrls: (token: string | null, port: number) => string[];
    redactUrl: (url: string) => string;
    env?: NodeJS.ProcessEnv;
    writeLine?: (message?: string) => void;
  },
): void {
  const dashboardUi = agent.dashboardUi;
  const env = deps.env ?? process.env;
  if (!dashboardUi || !dashboardUiEnabled(agent, env)) return;

  const writeLine = deps.writeLine ?? console.log;
  const port = dashboardUiPort(agent, env);
  writeLine("");
  writeLine(`  ${agent.displayName} ${dashboardUi.label}`);
  writeLine(`  Port ${port} must be forwarded before opening this URL.`);
  const seen = new Set<string>();
  for (const baseUrl of deps.buildControlUiUrls(null, port)) {
    const withoutHash = baseUrl.split("#")[0].replace(/\/$/, "");
    let urlPort = "";
    try {
      urlPort = new URL(withoutHash).port;
    } catch {
      urlPort = "";
    }
    if (urlPort !== String(port)) continue;
    const url =
      dashboardUi.path && dashboardUi.path !== "/"
        ? `${withoutHash}${dashboardUi.path}`
        : `${withoutHash}/`;
    if (seen.has(url)) continue;
    seen.add(url);
    writeLine(`  ${deps.redactUrl(url)}`);
  }
}
