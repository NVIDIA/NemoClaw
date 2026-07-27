// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const OPENSHELL_SANDBOX_HOST_BRIDGE = "host.openshell.internal";

function normalizeUrlHostname(hostname: string): string {
  return (hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname)
    .replace(/\.$/, "")
    .toLowerCase();
}

export function isAllowedOpenShellSandboxBridgeUrl(url: URL): boolean {
  const port = Number(url.port);
  return (
    normalizeUrlHostname(url.hostname) === OPENSHELL_SANDBOX_HOST_BRIDGE &&
    url.protocol === "http:" &&
    Number.isInteger(port) &&
    port >= 1024 &&
    port <= 65535 &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}
