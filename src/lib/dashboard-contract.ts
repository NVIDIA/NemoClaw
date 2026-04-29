// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard Delivery Contract — single source of truth for dashboard config.
 * Pure functions — no I/O, no process.env reads.
 */

import { DASHBOARD_PORT } from "./ports";
import { isLoopbackHostname } from "./url-utils";

export interface PlatformHints {
  chatUiUrl?: string;
  port?: number;
  isWsl?: boolean;
  wslHostAddress?: string | null;
}

export interface DashboardDeliveryChain {
  accessUrl: string;
  corsOrigins: string[];
  forwardTarget: string;
  healthEndpoint: string;
  port: number;
  bindAddress: string;
  shouldDisableDeviceAuth: boolean;
}

function ensureScheme(raw: string): string {
  return /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
}

function resolvePort(chatUiUrl: string, defaultPort: number): number {
  const raw = String(chatUiUrl || "").trim();
  if (!raw) return defaultPort;
  try {
    const parsed = new URL(ensureScheme(raw));
    return parsed.port ? Number(parsed.port) : defaultPort;
  } catch {
    const m = raw.match(/:(\d{2,5})(?:[/?#]|$)/);
    return m ? Number(m[1]) : defaultPort;
  }
}

function isLoopbackUrl(chatUiUrl: string): boolean {
  const raw = String(chatUiUrl || "").trim();
  if (!raw) return true;
  try {
    return isLoopbackHostname(new URL(ensureScheme(raw)).hostname);
  } catch {
    return /localhost|::1|127(?:\.\d{1,3}){3}/i.test(raw);
  }
}

/** Build the complete dashboard delivery chain from platform hints. */
export function buildChain(hints?: PlatformHints): DashboardDeliveryChain {
  const h = hints || {};
  const chatUiUrl = String(h.chatUiUrl || "").trim();
  const rawPort = h.port ?? resolvePort(chatUiUrl, DASHBOARD_PORT);
  const port = Number.isFinite(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : DASHBOARD_PORT;
  const hasNonLoopbackUrl = chatUiUrl !== "" && !isLoopbackUrl(chatUiUrl);

  let accessUrl: string;
  if (hasNonLoopbackUrl) {
    accessUrl = ensureScheme(chatUiUrl);
  } else if (h.isWsl && h.wslHostAddress) {
    accessUrl = `http://${h.wslHostAddress}:${port}`;
  } else {
    accessUrl = `http://127.0.0.1:${port}`;
  }

  const forwardTarget = h.isWsl || hasNonLoopbackUrl ? `0.0.0.0:${port}` : String(port);
  const bindAddress = forwardTarget.includes(":") ? "0.0.0.0" : "127.0.0.1";
  const loopbackOrigin = `http://127.0.0.1:${port}`;
  const accessOrigin = (() => { try { return new URL(accessUrl).origin; } catch { return null; } })();
  const corsOrigins = accessOrigin && accessOrigin !== loopbackOrigin
    ? [loopbackOrigin, accessOrigin] : [loopbackOrigin];

  const shouldDisableDeviceAuth = hasNonLoopbackUrl || (h.isWsl ?? false);

  return { accessUrl, corsOrigins, forwardTarget, healthEndpoint: "/health", port, bindAddress, shouldDisableDeviceAuth };
}

/** Build the list of control UI URLs. Callers pass chatUiUrl explicitly. */
export function buildControlUiUrls(
  token: string | null = null,
  port: number = DASHBOARD_PORT,
  chatUiUrl?: string,
): string[] {
  const hash = token ? `#token=${encodeURIComponent(token)}` : "";
  const baseUrl = `http://127.0.0.1:${port}`;
  const urls = [`${baseUrl}/${hash}`];
  const chatUi = (chatUiUrl || "").trim().replace(/\/$/, "");
  if (chatUi && /^https?:\/\//i.test(chatUi) && chatUi !== baseUrl) {
    urls.push(`${chatUi}/${hash}`);
  }
  return [...new Set(urls)];
}
