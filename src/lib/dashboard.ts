// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard URL resolution and construction.
 */

import { DASHBOARD_PORT } from "./ports";
import { isLoopbackHostname } from "./url-utils";

const CONTROL_UI_PORT = DASHBOARD_PORT;
const CONTROL_UI_PATH = "/";

function resolveDashboardPort(chatUiUrl = `http://127.0.0.1:${CONTROL_UI_PORT}`): string {
  const raw = String(chatUiUrl || "").trim();
  if (!raw) return String(CONTROL_UI_PORT);
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
    return String(parsed.port || CONTROL_UI_PORT);
  } catch {
    const portMatch = raw.match(/:(\d{2,5})(?:[/?#]|$)/);
    return portMatch ? portMatch[1] : String(CONTROL_UI_PORT);
  }
}

export function resolveDashboardForwardTarget(
  chatUiUrl = `http://127.0.0.1:${CONTROL_UI_PORT}`,
): string {
  const raw = String(chatUiUrl || "").trim();
  const port = resolveDashboardPort(chatUiUrl);
  if (!raw) return port;
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
    return isLoopbackHostname(parsed.hostname) ? port : `0.0.0.0:${port}`;
  } catch {
    return /localhost|::1|127(?:\.\d{1,3}){3}/i.test(raw) ? port : `0.0.0.0:${port}`;
  }
}

export function buildControlUiUrls(
  token: string | null = null,
  port: number = CONTROL_UI_PORT,
): string[] {
  const hash = token ? `#token=${token}` : "";
  const baseUrl = `http://127.0.0.1:${port}`;
  const urls = [`${baseUrl}${CONTROL_UI_PATH}${hash}`];
  const chatUi = (process.env.CHAT_UI_URL || "").trim().replace(/\/$/, "");
  if (chatUi && /^https?:\/\//i.test(chatUi) && chatUi !== baseUrl) {
    urls.push(`${chatUi}${CONTROL_UI_PATH}${hash}`);
  }
  return [...new Set(urls)];
}
