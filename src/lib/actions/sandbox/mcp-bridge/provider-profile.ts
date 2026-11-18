// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import { endpointlessProviderProfilePath } from "../../../adapters/openshell/provider-profile";
import { REPOSITORY_ROOT } from "../../../core/repository-root";
import { validateMcpCredentialEnvName } from "../mcp-bridge-validation";

export const MCP_BRIDGE_PROVIDER_TYPE = "nemoclaw-mcp-v1";

/** A profile declares one credential name without deriving identity from its secret. */
export function mcpBridgeProviderType(credential: string): string {
  return `${MCP_BRIDGE_PROVIDER_TYPE}-${createHash("sha256").update(credential).digest("hex").slice(0, 32)}`;
}

export async function withMcpBridgeProviderProfile<T>(
  credential: string,
  use: (profilePath: string) => T | Promise<T>,
): Promise<T> {
  validateMcpCredentialEnvName(credential);
  const profile = YAML.parse(
    fs.readFileSync(
      endpointlessProviderProfilePath(REPOSITORY_ROOT, MCP_BRIDGE_PROVIDER_TYPE),
      "utf8",
    ),
  ) as Record<string, unknown>;
  profile.id = mcpBridgeProviderType(credential);
  profile.credentials = [
    {
      name: credential,
      env_vars: [credential],
      required: true,
      auth_style: "bearer",
      header_name: "Authorization",
      query_param: "",
    },
  ];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-profile-"));
  try {
    const profilePath = path.join(directory, "profile.json");
    fs.writeFileSync(profilePath, JSON.stringify(profile), { mode: 0o600, flag: "wx" });
    return await use(profilePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
