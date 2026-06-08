// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host normalisation + internal-host redaction for the agent-facing policy
 * context. Two responsibilities:
 *
 * - {@link canonicaliseHost} reduces a raw preset endpoint value (which can
 *   carry URL schemes, userinfo, ports, IPv6 brackets, or IPv4-mapped IPv6
 *   syntax) to a bare host stem suitable for redaction comparison.
 * - {@link isInternalHost} reports whether the canonical stem points at an
 *   address NemoClaw must not surface to the agent: RFC1918, loopback,
 *   link-local, cloud metadata, CGNAT, benchmarking, IPv6 ULA, the full
 *   `fe80::/10` IPv6 link-local range (`fe80` through `febf`), multicast,
 *   reserved zero, and the well-known internal DNS suffixes.
 *
 * Both helpers must run on the redaction-write path before any string
 * reaches the agent (markdown render or sandbox write). The canonicaliser
 * is intentionally strict: anything it cannot parse to a bare host is
 * dropped (redacted) rather than passed through, so future endpoint
 * shapes do not slip past the filter.
 */

const INTERNAL_DNS_SUFFIXES: ReadonlyArray<string> = [
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".intra",
  ".intranet",
  ".localdomain",
];

const RESERVED_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "broadcasthost",
]);

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function stripUrlSyntax(value: string): string {
  let working = value;
  // Strip an explicit URL scheme (`https://`, `ws://`, etc.) before any
  // host-stem handling so we never bake credentials or paths into the
  // canonical stem.
  const schemeMatch = working.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (schemeMatch) {
    working = working.slice(schemeMatch[0].length);
  }
  // Userinfo (`user:pass@host`) is dropped wholesale — by the time we are
  // computing a host stem we never want a secret in the rendered output.
  const at = working.lastIndexOf("@");
  if (at >= 0) {
    working = working.slice(at + 1);
  }
  // Path / query / fragment all end the authority section. Trim at the
  // first such delimiter so paths cannot impersonate a host stem.
  const pathDelimiter = working.search(/[/?#]/);
  if (pathDelimiter >= 0) {
    working = working.slice(0, pathDelimiter);
  }
  return working;
}

function stripBracketsAndPort(value: string): string {
  let working = value;
  if (working.startsWith("[")) {
    const closeBracket = working.indexOf("]");
    if (closeBracket > 0) {
      // Bracketed IPv6 literal — discard the optional `:port` suffix and
      // hand back the inner address. Anything before the bracket would be
      // malformed; leave the bracket-prefixed string untouched in that
      // case so the canonicaliser drops it.
      working = working.slice(1, closeBracket);
    }
    return working;
  }
  // For non-bracketed hosts strip exactly one trailing `:port` group when
  // the remainder before it is a hostname or IPv4 literal. IPv6 without
  // brackets is left as-is and handled by the IPv6 detector.
  if (working.includes(":")) {
    const last = working.lastIndexOf(":");
    const candidate = working.slice(0, last);
    const port = working.slice(last + 1);
    if (/^\d{1,5}$/.test(port) && candidate.length > 0 && !candidate.includes(":")) {
      working = candidate;
    }
  }
  return working;
}

function normaliseIPv4MappedIPv6(value: string): string {
  // RFC 4291 §2.5.5 allows ::ffff:0:0/96 to embed an IPv4 literal in the
  // last two groups (`::ffff:192.0.2.1`). Re-canonicalise to the plain
  // IPv4 stem so the IPv4 internal-range detector sees it.
  const lower = value.toLowerCase();
  const match = lower.match(/^(?:0*:)*ffff:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (match) return match[1];
  const match2 = lower.match(/^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (match2) return match2[1];
  return value;
}

/**
 * Reduce a raw preset endpoint value to a canonical bare host stem, or
 * return `null` when the value cannot be parsed safely. Values that fail
 * canonicalisation are dropped by the caller so they never reach the
 * rendered policy context.
 */
export function canonicaliseHost(value: string): string | null {
  if (typeof value !== "string") return null;
  const stripped = stripUrlSyntax(value.trim());
  if (!stripped) return null;
  const lowered = stripped.toLowerCase().replace(/\.$/, "");
  const withoutPort = stripBracketsAndPort(lowered);
  if (!withoutPort) return null;
  const remapped = normaliseIPv4MappedIPv6(withoutPort);
  if (!remapped) return null;
  // Reject anything that still smells like a port, path, scheme, or
  // userinfo after parsing — the canonicaliser failed to reduce it to a
  // bare stem and we must redact it.
  if (/[\s/?#@\\!]/.test(remapped)) return null;
  if (IPV4_PATTERN.test(remapped)) return remapped;
  if (remapped.includes(":")) {
    // Anything left containing a colon must be an IPv6 literal. Require
    // at least one `::` (compressed form) or three colons (full eight-
    // group form) before accepting it.
    if (/^[0-9a-f:.]+$/.test(remapped) && (remapped.includes("::") || remapped.split(":").length >= 3)) {
      return remapped;
    }
    return null;
  }
  if (!HOSTNAME_PATTERN.test(remapped)) return null;
  return remapped;
}

function looksLikeInternalIPv4(host: string): boolean {
  if (!IPV4_PATTERN.test(host)) return false;
  const octets = host.split(".");
  const parsed = octets.map((octet) => Number(octet));
  if (parsed.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parsed;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0 && parsed[2] === 0) return true;
  if (a >= 224) return true;
  return false;
}

function firstHextet(value: string): string | null {
  // Extract the first hextet of an IPv6 literal so we can match the whole
  // fe80::/10 link-local range — first 10 bits set, so the leading hextet
  // ranges from fe80 through febf inclusive. `::` (loopback / unspecified)
  // has no leading hextet and is handled separately by the caller.
  if (value.startsWith("::")) return null;
  const head = value.split(":", 1)[0] ?? "";
  if (!/^[0-9a-f]{1,4}$/.test(head)) return null;
  return head;
}

function looksLikeInternalIPv6(host: string): boolean {
  if (!host.includes(":")) return false;
  const normalised = host.toLowerCase();
  if (normalised === "::" || normalised === "::1") return true;
  const head = firstHextet(normalised);
  if (head !== null) {
    const headValue = Number.parseInt(head, 16);
    if (Number.isFinite(headValue) && headValue >= 0xfe80 && headValue <= 0xfebf) {
      return true;
    }
    if (head.startsWith("fc") || head.startsWith("fd")) return true;
    if (head.startsWith("ff")) return true;
  }
  // Catch IPv4-compatible IPv6 forms that survived canonicalisation
  // (`::a.b.c.d`).
  if (normalised.startsWith("::") && IPV4_PATTERN.test(normalised.slice(2))) {
    return looksLikeInternalIPv4(normalised.slice(2));
  }
  return false;
}

function looksLikeHostname(host: string): boolean {
  return HOSTNAME_PATTERN.test(host);
}

/**
 * Report whether the canonical host stem points at an internal address or
 * an unparseable form. Unparseable hosts are redacted on the safe side so
 * a malformed preset entry cannot quietly publish a stem the redactor did
 * not recognise.
 */
export function isInternalHost(host: string): boolean {
  if (!host) return false;
  if (RESERVED_HOSTS.has(host)) return true;
  if (looksLikeInternalIPv4(host)) return true;
  if (looksLikeInternalIPv6(host)) return true;
  for (const suffix of INTERNAL_DNS_SUFFIXES) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
  }
  // Final guard: anything that does not match a strict hostname grammar
  // after canonicalisation is treated as internal — the redactor errs on
  // the side of dropping unfamiliar forms.
  if (!looksLikeHostname(host) && !host.includes(":")) return true;
  return false;
}

export interface HostStemsResult {
  public: string[];
  redactedCount: number;
}

export function hostStemsFromEndpoints(rawHosts: ReadonlyArray<string>): HostStemsResult {
  const stems = new Set<string>();
  let redactedCount = 0;
  for (const raw of rawHosts) {
    const canonical = canonicaliseHost(raw);
    if (!canonical || isInternalHost(canonical)) {
      redactedCount += 1;
      continue;
    }
    stems.add(canonical);
  }
  return { public: Array.from(stems).sort(), redactedCount };
}
