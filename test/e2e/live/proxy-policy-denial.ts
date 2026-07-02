// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Detects a proxy-policy CONNECT denial in a reachability probe's error output.
 *
 * When the OpenShell gateway proxy denies a CONNECT by policy it returns HTTP
 * 403 (or 407 for proxy-auth), which Node surfaces as an `ERR_PROXY_TUNNEL`
 * error whose message is `tunneling socket could not be established,
 * statusCode=403`. Matching that tunnel error is CONNECT-denial-specific
 * evidence, not generic status-code text matching:
 *
 * - It proves the request actually went through the proxy. A direct or bypassed
 *   connection cannot produce a tunnel error (it fails with `ECONNREFUSED` /
 *   `ETIMEDOUT` instead), so those still take the unreachable/failure path.
 * - A real HTTP 403 *response* from the destination is reported by the probes as
 *   `HTTP_403` on the reachable path, never as an error, so an application-level
 *   403 is not mistaken for a proxy-policy denial.
 *
 * See NVIDIA/NemoClaw#3836.
 */
export function isProxyPolicyConnectDenial(errText: string): boolean {
  return /ERR_PROXY_TUNNEL|tunneling socket could not be established/i.test(errText);
}
