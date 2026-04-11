// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard URL resolution and construction.
 */

import { isLoopbackHostname } from "./url-utils";

const CONTROL_UI_PORT = 18789;
const CONTROL_UI_PATH = "/";

export function resolveDashboardForwardTarget(
  chatUiUrl = `http://127.0.0.1:${CONTROL_UI_PORT}`,
): string {
  const raw = String(chatUiUrl || "").trim();
  if (!raw) return String(CONTROL_UI_PORT);
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
    return isLoopbackHostname(parsed.hostname)
      ? String(CONTROL_UI_PORT)
      : `0.0.0.0:${CONTROL_UI_PORT}`;
  } catch {
    return /localhost|::1|127(?:\.\d{1,3}){3}/i.test(raw)
      ? String(CONTROL_UI_PORT)
      : `0.0.0.0:${CONTROL_UI_PORT}`;
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
