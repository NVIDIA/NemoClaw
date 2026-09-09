// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const WECHAT_ILINK_HOSTS = new Set(["ilinkai.weixin.qq.com", "ilinkai.wechat.com"]);
const WECHAT_ILINK_IDC_HOST_PATTERN = /^idc-[0-9]+[.]weixin[.]qq[.]com$/u;

export function normalizeWechatIlinkBaseUrl(value: unknown): string | undefined {
  const raw = String(value ?? "");
  if (/[\r\n]/.test(raw)) {
    throw new Error("WeChat baseUrl must not contain line breaks.");
  }
  const text = raw.trim();
  if (!text) return undefined;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("WeChat baseUrl must be a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new Error("WeChat baseUrl must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("WeChat baseUrl must not include credentials.");
  }
  const authority = text.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu)?.[1] ?? "";
  if (authority.includes(":")) {
    throw new Error("WeChat baseUrl must not include an explicit port.");
  }
  if (!isWechatIlinkHost(url.hostname)) {
    throw new Error("WeChat baseUrl must use an expected iLink host.");
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("WeChat baseUrl must be an iLink origin URL.");
  }

  return url.origin;
}

export function isWechatIlinkHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return WECHAT_ILINK_HOSTS.has(normalized) || isWechatIlinkIdcHost(normalized);
}

export function isWechatIlinkIdcHost(hostname: string): boolean {
  return WECHAT_ILINK_IDC_HOST_PATTERN.test(hostname.toLowerCase());
}

export function redactWechatIlinkDiagnostic(message: string): string {
  return message
    .replace(/\bhttps?:\/\/[^\s"'<>]+/giu, "[redacted URL]")
    .replace(
      /\b(?:ilinkai\.weixin\.qq\.com|ilinkai\.wechat\.com|idc-[0-9]+\.weixin\.qq\.com)\b/giu,
      "[redacted iLink host]",
    );
}
