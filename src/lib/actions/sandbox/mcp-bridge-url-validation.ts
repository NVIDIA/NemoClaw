// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveHostAddresses } from "../../adapters/dns/resolve";
import { isLoopbackHostname } from "../../private-networks";
import {
  isBlockedMcpUrlTargetHost,
  isOpenShellMcpHostAlias,
  MCP_SERVER_URL_MAX_LENGTH,
} from "../../security/mcp-url-target";
import { TOKEN_PREFIX_PATTERNS } from "../../security/secret-patterns";
import {
  assertEndpointResolvesPublic,
  isTrustedPrivateEndpointCapability,
  normalizeTrustedPrivateHost,
  type TrustedPrivateEndpointCapability,
} from "../../security/trusted-private-endpoint";
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
  // whyNotSourceFix: v0.0.99 exposes no attested driver gateway address.
  // regressionTest: URL validation and all three live adapters reject aliases.
  // removalCondition: remove only after a reviewed OpenShell capability exposes
  // an attested address; a future version number alone is not that capability.
  throw new McpBridgeError(
    `Authenticated MCP OpenShell host alias '${hostname}' is unavailable with OpenShell v0.0.99 because that release does not expose an attested driver gateway address for exact policy pinning. Use a normal HTTPS DNS endpoint with public address records.`,
    2,
  );
}

function rejectUnsupportedOpenShellMcpIpv6Literal(hostname: string): void {
  if (!(hostname.startsWith("[") && hostname.endsWith("]"))) return;
  // invalidState: an IPv6 literal reaches an OpenShell parser that cannot
  // represent and enforce its exact proxy target safely.
  // sourceBoundary: the pinned OpenShell proxy parser owns literal support.
  // whyNotSourceFix: v0.0.99 does not support this target form.
  // regressionTest: URL normalization and resolved-target preflight both reject
  // private and public IPv6 literals with this capability-specific result.
  // removalCondition: remove only with reviewed parser support and parity proof;
  // never infer the capability from semver alone.
  throw new McpBridgeError(
    "IPv6-literal MCP server URLs are not supported by the current OpenShell proxy target parser. Use a DNS hostname with public A/AAAA records.",
    2,
  );
}

function validateMcpServerUrlTarget(
  parsed: URL,
  trustedPrivateHosts: readonly string[] = [],
): void {
  const normalizedHostname = parsed.hostname.toLowerCase();
  if (
    isBlockedMcpUrlTargetHost(parsed.hostname) &&
    !trustedPrivateHosts.includes(normalizedHostname)
  ) {
    throw new McpBridgeError(
      `MCP server URL host '${parsed.hostname}' is a private, local, or special-use IP address. Use a routed private HTTPS endpoint and pass --trusted-private-host ${parsed.hostname}, or use a normal public HTTPS DNS endpoint.`,
      2,
    );
  }
}

export interface NormalizeMcpServerUrlOptions {
  trustedPrivateHosts?: readonly string[];
}

export interface McpBridgeTargetValidation {
  addresses: string[];
  trustedPrivateCapability?: TrustedPrivateEndpointCapability;
  trustedPrivateHost?: string;
}

export interface McpBridgeTargetPreflightOptions {
  trustedPrivateHosts?: readonly string[];
  requireTrustedPrivateEndpoint?: boolean;
}

export interface McpBridgeRecordedPinStatus {
  state: "match" | "drift" | "unresolved";
  currentAddresses?: string[];
  detail?: string;
}

export function normalizeMcpServerUrl(
  rawUrl: string,
  options: NormalizeMcpServerUrlOptions = {},
): string {
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
      "Authenticated MCP server URLs must use https:// so the configured MCP client uses TLS when OpenShell forwards credential-bearing requests. Managed mcp add enforces this for every agent; an agent-native registration path may accept a plain-http URL but bypasses NemoClaw credential replacement and egress policy.",
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
  rejectUnsupportedOpenShellMcpIpv6Literal(parsed.hostname);
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
  const trustedPrivateHosts = (options.trustedPrivateHosts ?? []).map((host) =>
    normalizeTrustedPrivateHost(host),
  );
  if (
    trustedPrivateHosts.includes(parsed.hostname.toLowerCase()) &&
    isLoopbackHostname(parsed.hostname)
  ) {
    throw new McpBridgeError(
      `MCP server URL host '${parsed.hostname}' is loopback. Sandbox loopback is not the host MCP service. Expose the exact MCP route through an HTTPS reverse proxy on a stable routed private address, then trust that routed host.`,
      2,
    );
  }
  validateMcpServerUrlTarget(parsed, trustedPrivateHosts);
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

export async function preflightMcpServerUrlResolvedTarget(
  parsed: URL,
  options: McpBridgeTargetPreflightOptions = {},
): Promise<McpBridgeTargetValidation> {
  // invalidState: a hostname is public at add time but later rebinds to an
  // unpinned address. sourceBoundary: NemoClaw pins the add-time public answers;
  // With its operator-controlled proxy_connect_by_hostname option disabled,
  // OpenShell v0.0.99 resolves, validates every answer against allowed_ips, and
  // connects with that same SocketAddr list. This URL validator cannot observe
  // gateway configuration; the documented guarantee and residual risk are
  // therefore explicitly conditional on that option remaining disabled.
  // whyNotSourceFix: duplicating DNS resolution here before each remote
  // connection would create a second, non-authoritative TOCTOU boundary outside
  // OpenShell's data plane.
  // regressionTest: e2e/support/mcp-bridge-sandbox.test.ts pins the exact
  // upstream source contract, and live/mcp-bridge.test.ts remaps DNS and proves
  // a 403 plus zero upstream requests for all three adapters.
  // removalCondition: revisit only when the pinned OpenShell implementation or
  // its allowed_ips resolve-validate-connect contract changes.
  rejectUnsupportedOpenShellMcpIpv6Literal(parsed.hostname);
  rejectUnsupportedOpenShellMcpHostAlias(parsed.hostname);
  const normalizedTrustedHosts = (options.trustedPrivateHosts ?? []).map((host) =>
    normalizeTrustedPrivateHost(host),
  );
  if (isBlockedMcpUrlTargetHost(parsed.hostname)) {
    validateMcpServerUrlTarget(parsed, normalizedTrustedHosts);
  }
  const result = await assertEndpointResolvesPublic(
    parsed.toString(),
    async (hostname) => resolveHostAddresses(hostname),
    { trustedPrivateHosts: normalizedTrustedHosts },
  );
  if (!result.ok) {
    if (result.reasonCode === "private-answer" && result.offendingAddress) {
      const guidance = isLoopbackHostname(result.offendingAddress)
        ? " Sandbox loopback is not the host MCP service. Use an HTTPS reverse proxy on a stable routed private address."
        : ` Use a routed private HTTPS endpoint and pass --trusted-private-host ${parsed.hostname}.`;
      throw new McpBridgeError(
        `MCP server URL host '${parsed.hostname}' resolves to private, local, or special-use address '${result.offendingAddress}'.${guidance}`,
        2,
        "rejected",
      );
    }
    throw new McpBridgeError(
      `MCP server URL target validation failed: ${result.reason ?? "the endpoint was rejected"}.`,
      2,
      result.reasonCode === "unresolved" ? "unresolved" : "rejected",
    );
  }
  const literalAddress = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname)
    ? parsed.hostname
    : undefined;
  const addresses = [...new Set(result.addresses?.length ? result.addresses : [literalAddress])]
    .filter((address): address is string => !!address)
    .map((address) => address.toLowerCase())
    .sort();
  if (addresses.length === 0) {
    throw new McpBridgeError(
      `MCP server URL host '${parsed.hostname}' resolved without any addresses before policy registration.`,
      2,
      "unresolved",
    );
  }
  const normalizedHostname = normalizeTrustedPrivateHost(parsed.hostname);
  const explicitTrust = normalizedTrustedHosts.includes(normalizedHostname);
  if (result.trustedPrivateEndpoint) {
    if (!isTrustedPrivateEndpointCapability(result.trustedPrivateCapability)) {
      throw new McpBridgeError(
        `MCP server URL host '${normalizedHostname}' did not return a provenance-checked trusted-private capability.`,
        2,
      );
    }
    const capabilityAddresses = [...result.trustedPrivateCapability.addresses]
      .map((address) => address.toLowerCase())
      .sort();
    if (
      capabilityAddresses.length !== addresses.length ||
      capabilityAddresses.some((address, index) => address !== addresses[index])
    ) {
      throw new McpBridgeError(
        `MCP server URL host '${normalizedHostname}' returned mixed public and private addresses. Trusted-private MCP endpoints must resolve only to supported routed private addresses.`,
        2,
      );
    }
    return {
      addresses,
      trustedPrivateCapability: result.trustedPrivateCapability,
      trustedPrivateHost: normalizedHostname,
    };
  }
  if (explicitTrust && options.requireTrustedPrivateEndpoint) {
    throw new McpBridgeError(
      `--trusted-private-host ${normalizedHostname} is unused because the MCP endpoint did not resolve to supported routed private addresses.`,
      2,
    );
  }
  return { addresses };
}

export async function inspectMcpRecordedTargetPins(
  parsed: URL,
  trustedPrivateHost: string,
  recordedPins: readonly string[],
): Promise<McpBridgeRecordedPinStatus> {
  try {
    const target = await preflightMcpServerUrlResolvedTarget(parsed, {
      trustedPrivateHosts: [trustedPrivateHost],
      requireTrustedPrivateEndpoint: true,
    });
    const matches =
      recordedPins.length === target.addresses.length &&
      recordedPins.every((address, index) => address === target.addresses[index]);
    return {
      state: matches ? "match" : "drift",
      currentAddresses: target.addresses,
      ...(!matches
        ? { detail: "Current DNS answers differ from the recorded trusted-private pins." }
        : {}),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const unresolved = error instanceof McpBridgeError && error.reasonCode === "unresolved";
    return { state: unresolved ? "unresolved" : "drift", detail };
  }
}

export function parseMcpUrl(rawUrl: string): URL {
  return new URL(normalizeMcpServerUrl(rawUrl));
}
