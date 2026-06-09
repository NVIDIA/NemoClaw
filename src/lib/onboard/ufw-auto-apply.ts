// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Opt-in UFW remediation for Linux Docker-driver sandbox -> gateway reachability.
 *
 * Invalid state boundary (#4265): the OpenShell gateway is healthy on the host,
 * but sandbox containers on the OpenShell Docker bridge cannot reach the host
 * gateway IP because host firewall INPUT policy drops bridge traffic. This is
 * host policy state outside the OpenShell route model, so remediation is kept
 * explicit, narrow, and removable once OpenShell/NemoClaw owns a first-class
 * firewall reconciliation layer for Docker-driver gateways.
 */

import { spawnSync } from "node:child_process";

import { GATEWAY_PORT } from "../core/ports";
import type { SandboxBridgeReachabilityResult } from "./gateway-sandbox-reachability";

/**
 * Result of attempting to auto-apply the UFW rule that opens
 * `<subnet> -> <gatewayIp>:<port>` so sandbox containers can reach the
 * gateway. (#4265)
 */
export interface UfwAutoApplyResult {
  applied: boolean;
  reason:
    | "applied"
    | "not_opted_in"
    | "no_subnet_or_gateway"
    | "invalid_rule_operand"
    | "ufw_missing"
    | "ufw_inactive"
    | "sudo_unavailable"
    | "ufw_rule_rejected";
  detail?: string;
}

export interface UfwAutoApplyOptions {
  port?: number;
  /**
   * Run a process with argv. Returns the exit code (null on signal/error)
   * and trimmed stderr/stdout. Injected for testability — callers in
   * production code should rely on the default which uses `spawnSync`.
   */
  runImpl?: (argv: readonly string[]) => { status: number | null; stdout: string; stderr: string };
  /** Override to force the opt-in check in tests or after a caller-level gate. */
  optedIn?: boolean;
}

function defaultRunArgv(argv: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf-8" });
  return {
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
  };
}

export function isUfwAutoApplyOptedIn(): boolean {
  return process.env.NEMOCLAW_AUTO_FIX_FIREWALL === "1";
}

function parseIpv4Address(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    result = (result << 8) + octet;
  }
  return result >>> 0;
}

function parseDockerBridgeCidr(
  value: string,
): { network: number; prefix: number; mask: number } | null {
  const [address, prefixRaw, extra] = value.split("/");
  if (!address || !prefixRaw || extra !== undefined) return null;
  if (!/^\d{1,2}$/.test(prefixRaw)) return null;
  const prefix = Number(prefixRaw);
  // Docker bridge networks should be narrow IPv4 networks. Reject broad ranges
  // such as 0.0.0.0/0 or 10.0.0.0/8 before changing host firewall policy.
  if (!Number.isInteger(prefix) || prefix < 16 || prefix > 32) return null;
  const network = parseIpv4Address(address);
  if (network === null) return null;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  if ((network & mask) >>> 0 !== network) return null;
  return { network, prefix, mask };
}

function validateUfwRuleOperands(
  subnet: string,
  gatewayIp: string,
  port: number,
): string | undefined {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return `invalid port ${port}`;
  }
  const cidr = parseDockerBridgeCidr(subnet);
  if (!cidr) {
    return `invalid or overly broad IPv4 subnet ${subnet}`;
  }
  const gateway = parseIpv4Address(gatewayIp);
  if (gateway === null) {
    return `invalid IPv4 gateway ${gatewayIp}`;
  }
  if ((gateway & cidr.mask) >>> 0 !== cidr.network) {
    return `gateway ${gatewayIp} is outside subnet ${subnet}`;
  }
  return undefined;
}

function sanitizeUfwDetail(value: string): string {
  const clean = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "ufw rejected the rule.";
  return clean.length > 240 ? `${clean.slice(0, 237)}...` : clean;
}

/**
 * Try to apply the `ufw allow from <subnet> to <gatewayIp> port <port>` rule
 * non-interactively. Only fires when the operator has opted in via
 * `NEMOCLAW_AUTO_FIX_FIREWALL=1` or when the caller has already performed an
 * equivalent explicit-consent gate and passes `optedIn: true`. Returns a
 * structured result so the caller can decide whether to re-probe reachability.
 * (#4265)
 *
 * Safety:
 * - Opt-in only — operators must set `NEMOCLAW_AUTO_FIX_FIREWALL=1` unless a
 *   higher-level caller has an equivalent explicit consent surface.
 * - `sudo -n` only — never prompts for a password. If passwordless sudo isn't
 *   available, falls back to the existing manual-instructions path.
 * - Skips on hosts without UFW or with UFW inactive (the rule is moot there).
 * - Validates the rule operands before invoking sudo/ufw: narrow IPv4 Docker
 *   bridge CIDR, gateway inside that CIDR, and a valid TCP port.
 * - The rule itself is narrow: docker-bridge subnet → host gateway port only.
 */
export function tryAutoApplyUfwRule(
  reach: SandboxBridgeReachabilityResult,
  options: UfwAutoApplyOptions = {},
): UfwAutoApplyResult {
  const port = options.port ?? GATEWAY_PORT;
  const run = options.runImpl ?? defaultRunArgv;
  const optedIn = options.optedIn ?? isUfwAutoApplyOptedIn();

  if (!optedIn) return { applied: false, reason: "not_opted_in" };
  if (!reach.subnet || !reach.gatewayIp) {
    return { applied: false, reason: "no_subnet_or_gateway" };
  }

  const invalidOperand = validateUfwRuleOperands(reach.subnet, reach.gatewayIp, port);
  if (invalidOperand) {
    return { applied: false, reason: "invalid_rule_operand", detail: invalidOperand };
  }

  const sudoCheck = run(["sudo", "-n", "true"]);
  if (sudoCheck.status !== 0) {
    return {
      applied: false,
      reason: "sudo_unavailable",
      detail: "Passwordless sudo not available; cannot auto-apply UFW rule.",
    };
  }

  const ufwWhich = run(["sudo", "-n", "which", "ufw"]);
  if (ufwWhich.status !== 0) {
    return { applied: false, reason: "ufw_missing", detail: "ufw not installed." };
  }

  const status = run(["sudo", "-n", "ufw", "status"]);
  if (status.status !== 0 || !/Status:\s*active/i.test(status.stdout)) {
    return { applied: false, reason: "ufw_inactive", detail: "ufw is not active." };
  }

  const apply = run([
    "sudo",
    "-n",
    "ufw",
    "allow",
    "from",
    reach.subnet,
    "to",
    reach.gatewayIp,
    "port",
    String(port),
    "proto",
    "tcp",
  ]);
  if (apply.status !== 0) {
    return {
      applied: false,
      reason: "ufw_rule_rejected",
      detail: sanitizeUfwDetail(apply.stderr || apply.stdout || "ufw rejected the rule."),
    };
  }

  return { applied: true, reason: "applied", detail: apply.stdout || undefined };
}

export const __test = {
  parseDockerBridgeCidr,
  parseIpv4Address,
  sanitizeUfwDetail,
  validateUfwRuleOperands,
};
