// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveHostAddresses } from "../../adapters/dns/resolve";
import {
  isBlockedMcpUrlTargetHost,
  isOpenShellMcpHostAlias,
  MCP_SERVER_URL_MAX_LENGTH,
} from "../../security/mcp-url-target";
import { TOKEN_PREFIX_PATTERNS } from "../../security/secret-patterns";
import { McpBridgeError } from "./mcp-bridge-contracts";

export { MCP_SERVER_URL_MAX_LENGTH } from "../../security/mcp-url-target";

const MCP_PATH_CREDENTIAL_PATTERNS = TOKEN_PREFIX_PATTERNS.map(
  // Validation rejects a token contained anywhere in a persisted segment.
  // Redaction's word boundaries are inappropriate here because '-' is a valid
  // final Telegram/Discord token character but is not a RegExp "word" byte.
  (pattern) => new RegExp(pattern.source.replaceAll("\\b", ""), pattern.flags.replace("g", "")),
);
const MCP_DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function validateCanonicalMcpDnsHostname(hostname: string): void {
  if (hostname.length > 253 || hostname.split(".").some((label) => !MCP_DNS_LABEL_RE.test(label))) {
    throw new McpBridgeError(
      "MCP server URL hostnames must use canonical DNS labels: lowercase letters, digits, and internal hyphens only, with no empty or overlong labels.",
      2,
    );
  }
}

/** Reject self-identifying credentials in persisted endpoint path segments. */
function hasSecretShapedMcpPathSegment(pathname: string): boolean {
  return pathname.split("/").some((segment) => {
    if (!segment) return false;
    return MCP_PATH_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(segment));
  });
}

function rejectUnsupportedOpenShellMcpHostAlias(hostname: string): void {
  if (!isOpenShellMcpHostAlias(hostname)) return;
  // invalidState: a host alias is accepted without an attested gateway address,
  // forcing broad private-range policy instead of an exact destination pin.
  // sourceBoundary: the pinned OpenShell release owns gateway-address discovery.
  // whyNotSourceFix: v0.0.72 exposes no attested driver gateway address.
  // regressionTest: URL validation and all three live adapters reject aliases.
  // removalCondition: remove only after a reviewed OpenShell capability exposes
  // an attested address; a future version number alone is not that capability.
  throw new McpBridgeError(
    `Authenticated MCP OpenShell host alias '${hostname}' is unavailable with OpenShell v0.0.72 because that release does not expose an attested driver gateway address for exact policy pinning. Use a normal HTTPS DNS endpoint with public address records.`,
    2,
  );
}

function validateMcpServerUrlTarget(parsed: URL): void {
  if (isBlockedMcpUrlTargetHost(parsed.hostname)) {
    throw new McpBridgeError(
      `MCP server URL host '${parsed.hostname}' is a private, local, or special-use IP address. Use a normal HTTPS DNS endpoint with public address records.`,
      2,
    );
  }
}

export function normalizeMcpServerUrl(rawUrl: string): string {
  if (rawUrl.length > MCP_SERVER_URL_MAX_LENGTH) {
    throw new McpBridgeError(
      `MCP server URL must be at most ${MCP_SERVER_URL_MAX_LENGTH} characters.`,
      2,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new McpBridgeError(`Invalid MCP server URL '${rawUrl}'.`, 2);
  }
  if (parsed.protocol !== "https:") {
    throw new McpBridgeError(
      "Authenticated MCP server URLs must use https:// so the configured MCP client uses TLS when OpenShell forwards credential-bearing requests.",
      2,
    );
  }
  if (!parsed.hostname) {
    throw new McpBridgeError("MCP server URL must include a hostname.", 2);
  }
  if (/[*{};]/.test(parsed.hostname)) {
    throw new McpBridgeError(
      "MCP server URL hosts must be literal; wildcard and glob hostnames are not supported.",
      2,
    );
  }
  if (parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")) {
    // invalidState: an IPv6 literal reaches an OpenShell parser that cannot
    // represent and enforce its exact proxy target safely.
    // sourceBoundary: the pinned OpenShell proxy parser owns literal support.
    // whyNotSourceFix: v0.0.72 does not support this target form.
    // regressionTest: host/Hermes parity rejects private and public IPv6 literals.
    // removalCondition: remove only with reviewed parser support and parity proof;
    // never infer the capability from semver alone.
    throw new McpBridgeError(
      "IPv6-literal MCP server URLs are not supported by the current OpenShell proxy target parser. Use a DNS hostname with public A/AAAA records.",
      2,
    );
  }
  if (parsed.username || parsed.password) {
    throw new McpBridgeError(
      "MCP server URL must not embed credentials. Use --env KEY so OpenShell resolves host-only credentials.",
      2,
    );
  }
  if (rawUrl.includes("?") || parsed.search) {
    throw new McpBridgeError(
      "MCP server URLs must not include a query string because URLs are persisted and displayed. Put credentials in --env and use a stable endpoint path.",
      2,
    );
  }
  if (rawUrl.includes("#") || parsed.hash) {
    throw new McpBridgeError(
      "MCP server URLs must not include a fragment because fragments are not sent to the server.",
      2,
    );
  }
  if (parsed.port === "0") {
    throw new McpBridgeError("MCP server URL port must be between 1 and 65535.", 2);
  }
  if (
    rawUrl.includes("%") ||
    parsed.pathname.includes("%") ||
    rawUrl.includes("\\") ||
    /\/{2,}/.test(parsed.pathname) ||
    /[\*\[\]\{\};]/.test(parsed.pathname)
  ) {
    throw new McpBridgeError(
      "MCP server URL paths must be literal and canonical; percent characters, backslashes, semicolons, and glob metacharacters are not supported.",
      2,
    );
  }
  if (hasSecretShapedMcpPathSegment(parsed.pathname)) {
    throw new McpBridgeError(
      "MCP server URL paths must not contain secret-shaped credential material because the full URL is persisted and displayed. Put the bearer credential in --env KEY.",
      2,
    );
  }
  rejectUnsupportedOpenShellMcpHostAlias(parsed.hostname);
  validateMcpServerUrlTarget(parsed);
  if (parsed.hostname.endsWith(".")) {
    throw new McpBridgeError(
      "MCP server URL hostnames must use canonical spelling without a trailing dot.",
      2,
    );
  }
  validateCanonicalMcpDnsHostname(parsed.hostname);
  if (!parsed.pathname) parsed.pathname = "/";
  const normalized = parsed.toString();
  if (normalized.length > MCP_SERVER_URL_MAX_LENGTH) {
    throw new McpBridgeError(
      `MCP server URL must be at most ${MCP_SERVER_URL_MAX_LENGTH} characters after normalization.`,
      2,
    );
  }
  return normalized;
}

export async function validateMcpServerUrlResolvedTarget(parsed: URL): Promise<string[]> {
  // invalidState: a hostname is public at add time but later rebinds to an
  // unpinned address. sourceBoundary: NemoClaw pins the add-time public answers;
  // OpenShell v0.0.72 resolves, validates every answer against allowed_ips, and
  // connects with that same SocketAddr list. whyNotSourceFix: duplicating DNS
  // resolution here before each remote connection would create a second,
  // non-authoritative TOCTOU boundary outside OpenShell's data plane.
  // regressionTest: e2e/support/mcp-bridge-sandbox.test.ts pins the exact
  // upstream source contract, and live/mcp-bridge.test.ts remaps DNS and proves
  // a 403 plus zero upstream requests for all three adapters.
  // removalCondition: revisit only when the pinned OpenShell implementation or
  // its allowed_ips resolve-validate-connect contract changes.
  rejectUnsupportedOpenShellMcpHostAlias(parsed.hostname);
  if (isBlockedMcpUrlTargetHost(parsed.hostname)) {
    validateMcpServerUrlTarget(parsed);
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolveHostAddresses(parsed.hostname);
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
    throw new McpBridgeError(
      `MCP server URL host '${parsed.hostname}' could not be resolved before policy registration.${detail}`,
      2,
    );
  }
  if (addresses.length === 0) {
    throw new McpBridgeError(
      `MCP server URL host '${parsed.hostname}' resolved without any addresses before policy registration.`,
      2,
    );
  }
  for (const { address } of addresses) {
    if (isBlockedMcpUrlTargetHost(address)) {
      throw new McpBridgeError(
        `MCP server URL host '${parsed.hostname}' resolves to private, local, or special-use address '${address}'. Use a normal HTTPS DNS endpoint with public address records.`,
        2,
      );
    }
  }
  return [...new Set(addresses.map(({ address }) => address.toLowerCase()))].sort();
}

export function parseMcpUrl(rawUrl: string): URL {
  return new URL(normalizeMcpServerUrl(rawUrl));
}
