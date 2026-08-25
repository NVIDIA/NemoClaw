// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { stringify as stringifyToml } from "smol-toml";
import YAML from "yaml";
import { OPENSHELL_SANDBOX_HOST_BRIDGE } from "../private-networks";

export const CUA_SERVICE_ROLES = ["browser", "computer", "terminal", "fixture"] as const;
export type CuaServiceRole = (typeof CUA_SERVICE_ROLES)[number];

export const CUA_SERVICE_ENDPOINT_ENV = {
  browser: "NEMOCLAW_CUA_BROWSER_ENDPOINT",
  computer: "NEMOCLAW_CUA_COMPUTER_ENDPOINT",
  terminal: "NEMOCLAW_CUA_TERMINAL_ENDPOINT",
  fixture: "NEMOCLAW_CUA_FIXTURE_ENDPOINT",
} as const satisfies Record<CuaServiceRole, string>;

export interface CuaServiceEndpoint {
  role: CuaServiceRole;
  sandboxUrl: string;
  path: string;
  port: number;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parseServiceEndpoint(role: CuaServiceRole, raw: string): CuaServiceEndpoint {
  if (raw.length === 0 || raw.length > 2048 || raw.trim() !== raw || /[\x00-\x1f\x7f]/u.test(raw)) {
    throw new Error(`${CUA_SERVICE_ENDPOINT_ENV[role]} must be one bounded HTTP loopback URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${CUA_SERVICE_ENDPOINT_ENV[role]} must be one bounded HTTP loopback URL`);
  }
  if (
    parsed.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(parsed.hostname === "::1" ? "[::1]" : parsed.hostname.toLowerCase()) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.port === ""
  ) {
    throw new Error(
      `${CUA_SERVICE_ENDPOINT_ENV[role]} must use http, an exact loopback host, an explicit port, and no credentials, query, or fragment`,
    );
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${CUA_SERVICE_ENDPOINT_ENV[role]} must use a port from 1024 through 65535`);
  }
  const sandbox = new URL(parsed.href);
  sandbox.hostname = OPENSHELL_SANDBOX_HOST_BRIDGE;
  const endpointPath = parsed.pathname.replace(/\/+$/u, "") || "/";
  return { role, sandboxUrl: sandbox.href, path: endpointPath, port };
}

/** Read the closed four-service host adapter contract when NemoCUA is enabled. */
export function requireCuaServiceEndpoints(
  env: NodeJS.ProcessEnv = process.env,
): readonly CuaServiceEndpoint[] {
  const endpoints = CUA_SERVICE_ROLES.map((role) => {
    const raw = env[CUA_SERVICE_ENDPOINT_ENV[role]];
    if (typeof raw !== "string") {
      throw new Error(`${CUA_SERVICE_ENDPOINT_ENV[role]} is required for NemoCUA onboarding`);
    }
    return parseServiceEndpoint(role, raw);
  });
  const ports = endpoints.map(({ port }) => port);
  if (new Set(ports).size !== ports.length) {
    throw new Error(
      "NemoCUA browser, computer, terminal, and fixture endpoints must use distinct ports",
    );
  }
  return endpoints;
}

/** Render the non-secret service section consumed by the prepared NemoCUA harness. */
export function renderCuaServiceConfig(endpoints: readonly CuaServiceEndpoint[]): string {
  return stringifyToml({
    services: Object.fromEntries(endpoints.map(({ role, sandboxUrl }) => [role, sandboxUrl])),
  });
}

/** Replace the NemoCUA network map with inference and the selected host services. */
export function materializeCuaServicePolicy(
  content: string,
  endpoints: readonly CuaServiceEndpoint[],
): string {
  const policy = YAML.parse(content) as Record<string, unknown>;
  const networkPolicies = policy.network_policies;
  if (
    typeof networkPolicies !== "object" ||
    networkPolicies === null ||
    Array.isArray(networkPolicies)
  ) {
    throw new Error("NemoCUA baseline policy is missing its network policy map");
  }
  const managedInference = (networkPolicies as Record<string, unknown>).managed_inference;
  if (!managedInference) throw new Error("NemoCUA baseline policy is missing managed inference");

  policy.network_policies = {
    managed_inference: managedInference,
    ...Object.fromEntries(
      endpoints.map(({ role, path, port }) => [
        `nemocua_${role}`,
        {
          name: `nemocua_${role}`,
          endpoints: [
            {
              host: OPENSHELL_SANDBOX_HOST_BRIDGE,
              port,
              allowed_ips: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
              protocol: "rest",
              enforcement: "enforce",
              rules: [
                { allow: { method: "GET", path } },
                { allow: { method: "GET", path: `${path === "/" ? "" : path}/**` } },
                { allow: { method: "POST", path } },
                { allow: { method: "POST", path: `${path === "/" ? "" : path}/**` } },
              ],
            },
          ],
          binaries: [{ path: "/usr/bin/python3" }, { path: "/usr/local/bin/python3" }],
        },
      ]),
    ),
  };
  return YAML.stringify(policy);
}
