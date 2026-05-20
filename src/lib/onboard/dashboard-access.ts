// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WslDetectionOptions } from "../platform";
import { isWsl } from "../platform";
import { DASHBOARD_PORT } from "../core/ports";
import { buildChain, buildControlUiUrls } from "../dashboard/contract";

type RunCapture = (args: string[], options: { ignoreError: true }) => string;
type OpenshellShellCommand = (args: string[], options?: { openshellBinary?: string }) => string;

export type DashboardAccessOptions = WslDetectionOptions & {
  chatUiUrl?: string;
  token?: string | null;
  wslHostAddress?: string | null;
  runCapture?: RunCapture;
  openshellBinary?: string;
  openshellShellCommand?: OpenshellShellCommand;
  fetchGatewayAuthToken?: (sandboxName: string) => string | null;
  env?: NodeJS.ProcessEnv;
};

export type DashboardAccessEntry = {
  label: string;
  url: string;
};

const CONTROL_UI_PORT = DASHBOARD_PORT;

function defaultChatUiUrl(options: DashboardAccessOptions = {}): string {
  return options.chatUiUrl || options.env?.CHAT_UI_URL || process.env.CHAT_UI_URL || `http://127.0.0.1:${CONTROL_UI_PORT}`;
}

export function getWslHostAddress(options: DashboardAccessOptions = {}): string | null {
  if (options.wslHostAddress) {
    return options.wslHostAddress;
  }
  if (!isWsl(options)) {
    return null;
  }
  const runCaptureFn = options.runCapture;
  if (!runCaptureFn) return null;
  const output = runCaptureFn(["hostname", "-I"], { ignoreError: true });
  return (
    String(output || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)[0] || null
  );
}

/**
 * Read the operator-opt-in remote-bind env var. Only "0.0.0.0" enables the
 * remote bind; anything else (empty, "127.0.0.1", invalid IPs) leaves the
 * default loopback bind. (#3259)
 */
function readBindOverride(options: DashboardAccessOptions): string | undefined {
  const raw = options.env?.NEMOCLAW_DASHBOARD_BIND ?? process.env.NEMOCLAW_DASHBOARD_BIND;
  return typeof raw === "string" ? raw : undefined;
}

/**
 * I/O-boundary wrapper around the pure `buildChain` function. Resolves the
 * platform hints (`isWsl`, `wslHostAddress`, `bindOverride`) from the host
 * environment and config, then delegates the actual decision to `buildChain`
 * so the contract stays a pure function and tests can call `buildChain`
 * directly without env mocks. Callers in onboard / status / doctor share
 * this entry point so the same hints apply consistently across the CLI.
 */
export function buildDashboardChain(
  chatUiUrl = defaultChatUiUrl(),
  options: DashboardAccessOptions = {},
) {
  return buildChain({
    chatUiUrl,
    isWsl: isWsl(options),
    wslHostAddress: getWslHostAddress(options),
    bindOverride: readBindOverride(options),
  });
}

export function getDashboardForwardPort(
  chatUiUrl = defaultChatUiUrl(),
  options: DashboardAccessOptions = {},
): string {
  return String(buildDashboardChain(chatUiUrl, options).port);
}

export function getDashboardForwardTarget(
  chatUiUrl = defaultChatUiUrl(),
  options: DashboardAccessOptions = {},
): string {
  return buildDashboardChain(chatUiUrl, options).forwardTarget;
}

export function getDashboardForwardStartCommand(
  sandboxName: string,
  options: DashboardAccessOptions = {},
): string {
  if (!options.openshellShellCommand) {
    throw new Error("getDashboardForwardStartCommand requires openshellShellCommand");
  }
  const chatUiUrl = defaultChatUiUrl(options);
  const forwardTarget = getDashboardForwardTarget(chatUiUrl, options);
  return `${options.openshellShellCommand(
    ["forward", "start", "--background", forwardTarget, sandboxName],
    options,
  )}`;
}

export function buildAuthenticatedDashboardUrl(baseUrl: string, token: string | null = null): string {
  if (!token) return baseUrl;
  return `${baseUrl}#token=${encodeURIComponent(token)}`;
}

export function dashboardUrlForDisplay(url: string, redact: (value: string) => string = (value) => value): string {
  return redact(url.replace(/#token=[^\s'"]*$/i, ""));
}

export function getDashboardAccessInfo(
  sandboxName: string,
  options: DashboardAccessOptions = {},
): DashboardAccessEntry[] {
  const token = Object.prototype.hasOwnProperty.call(options, "token")
    ? options.token
    : options.fetchGatewayAuthToken?.(sandboxName) ?? null;
  const chatUiUrl = defaultChatUiUrl(options);
  const chain = buildDashboardChain(chatUiUrl, options);
  const dashboardAccess = buildControlUiUrls(token ?? null, chain.port, chain.accessUrl).map(
    (url, index) => ({
      label: index === 0 ? "Dashboard" : `Alt ${index}`,
      url: buildAuthenticatedDashboardUrl(url, null),
    }),
  );

  const wslHostAddress = getWslHostAddress(options);
  if (wslHostAddress) {
    const wslUrl = buildAuthenticatedDashboardUrl(`http://${wslHostAddress}:${chain.port}/`, token ?? null);
    if (!dashboardAccess.some((access) => access.url === wslUrl)) {
      dashboardAccess.push({ label: "VS Code/WSL", url: wslUrl });
    }
  }

  return dashboardAccess;
}

export function getDashboardGuidanceLines(
  dashboardAccess: DashboardAccessEntry[] = [],
  options: DashboardAccessOptions = {},
): string[] {
  const chatUiUrl = defaultChatUiUrl(options);
  const chain = buildDashboardChain(chatUiUrl, options);
  const guidance = [`Port ${String(chain.port)} must be forwarded before opening these URLs.`];
  if (isWsl(options)) {
    guidance.push(
      "WSL detected: if localhost fails in Windows, use the WSL host IP shown by `hostname -I`.",
    );
  }
  if (dashboardAccess.length === 0) {
    guidance.push("No dashboard URLs were generated.");
  }
  return guidance;
}
