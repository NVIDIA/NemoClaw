// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { GATEWAY_PORT } from "./ports";

export const DEFAULT_GATEWAY_BIND_ADDRESS = "127.0.0.1";
export const WILDCARD_GATEWAY_BIND_ADDRESS = "0.0.0.0";

export type GatewayBindAddress =
  | typeof DEFAULT_GATEWAY_BIND_ADDRESS
  | typeof WILDCARD_GATEWAY_BIND_ADDRESS;

export function parseGatewayBindAddress(
  envVar = "NEMOCLAW_GATEWAY_BIND_ADDRESS",
  fallback: GatewayBindAddress = DEFAULT_GATEWAY_BIND_ADDRESS,
): GatewayBindAddress {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") return fallback;
  const trimmed = String(raw).trim();
  if (trimmed === DEFAULT_GATEWAY_BIND_ADDRESS) return DEFAULT_GATEWAY_BIND_ADDRESS;
  if (trimmed === WILDCARD_GATEWAY_BIND_ADDRESS) return WILDCARD_GATEWAY_BIND_ADDRESS;
  throw new Error(
    `Invalid gateway bind address: ${envVar}="${raw}" — must be either ${DEFAULT_GATEWAY_BIND_ADDRESS} or ${WILDCARD_GATEWAY_BIND_ADDRESS}`,
  );
}

export const GATEWAY_BIND_ADDRESS = parseGatewayBindAddress();

export function getGatewayConnectHost(
  bindAddress: GatewayBindAddress = GATEWAY_BIND_ADDRESS,
): string {
  return bindAddress === WILDCARD_GATEWAY_BIND_ADDRESS
    ? DEFAULT_GATEWAY_BIND_ADDRESS
    : bindAddress;
}

export function getGatewayHttpEndpoint(
  port: number = GATEWAY_PORT,
  bindAddress: GatewayBindAddress = GATEWAY_BIND_ADDRESS,
): string {
  return `http://${getGatewayConnectHost(bindAddress)}:${port}`;
}

export function getGatewayHttpsEndpoint(
  port: number = GATEWAY_PORT,
  bindAddress: GatewayBindAddress = GATEWAY_BIND_ADDRESS,
): string {
  return `https://${getGatewayConnectHost(bindAddress)}:${port}`;
}
