// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type OpenShellGatewayMode = "docker" | "packaged";

export const NEMOCLAW_DOCKER_GATEWAY_NAME = "nemoclaw";
export const OPENSHELL_PACKAGED_GATEWAY_NAME = "local";
export const OPENSHELL_PACKAGED_GATEWAY_ENDPOINT = "http://127.0.0.1:17670";

function normalize(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function getOpenShellGatewayMode(
  env: NodeJS.ProcessEnv = process.env,
): OpenShellGatewayMode {
  const rawMode = normalize(env.NEMOCLAW_OPENSHELL_GATEWAY_MODE);
  if (rawMode === "packaged" || rawMode === "deb" || rawMode === "dev") return "packaged";
  if (rawMode === "docker" || rawMode === "cluster" || rawMode === "k3s") return "docker";

  const channel = normalize(env.NEMOCLAW_OPENSHELL_CHANNEL);
  if (channel === "dev" || channel === "main" || channel === "deb") return "packaged";

  return "docker";
}

export function isPackagedGatewayMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return getOpenShellGatewayMode(env) === "packaged";
}

export function usesDockerManagedGateway(env: NodeJS.ProcessEnv = process.env): boolean {
  return getOpenShellGatewayMode(env) === "docker";
}

export function getManagedGatewayName(env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.NEMOCLAW_OPENSHELL_GATEWAY_NAME || "").trim();
  if (override) return override;
  return isPackagedGatewayMode(env) ? OPENSHELL_PACKAGED_GATEWAY_NAME : NEMOCLAW_DOCKER_GATEWAY_NAME;
}

export function getPackagedGatewayEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const override = String(env.NEMOCLAW_OPENSHELL_GATEWAY_ENDPOINT || "").trim();
  return override || OPENSHELL_PACKAGED_GATEWAY_ENDPOINT;
}
