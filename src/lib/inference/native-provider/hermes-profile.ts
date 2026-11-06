// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import type { NativeProviderDefinition } from "./contract";
import { requireHermesEndpointPins } from "./hermes-pins";
import { hostedNativeProvider } from "./hosted";
import { isAllowedOpenShellSandboxBridgeUrl } from "../../private-networks";

/** Reuse the checked-in Hermes boundary for its recorded endpoint. */
export function boundHermesNativeProfile(definition: NativeProviderDefinition): string {
  const expected = hostedNativeProvider("hermes-provider", definition.endpointUrl);
  if (
    !expected ||
    expected.profileId !== definition.profileId ||
    expected.providerName !== definition.providerName
  ) {
    throw new Error("Hermes provider identity does not match its endpoint binding");
  }
  const profile = YAML.parse(
    fs.readFileSync(
      path.join(
        REPOSITORY_ROOT,
        "managed-inference/provider-profiles/nemoclaw-hermes-inference-v1.yaml",
      ),
      "utf8",
    ),
  );
  const endpoint = new URL(expected.endpoint);
  if (isAllowedOpenShellSandboxBridgeUrl(endpoint)) {
    // Load host port ownership only when validating a host route; it initializes registry locks.
    const { isProtectedLocalInferencePort } =
      require("../gateway/local-endpoint-ports") as typeof import("../gateway/local-endpoint-ports");
    if (isProtectedLocalInferencePort(Number(endpoint.port)))
      throw new Error("The recorded Hermes endpoint uses a protected host port");
  }
  const prefix = endpoint.pathname.replace(/\/+$/, "");
  const allowedIps = requireHermesEndpointPins(expected.endpoint, definition.allowedIps);
  profile.id = expected.profileId;
  profile.endpoints = [
    {
      host: endpoint.hostname.replace(/^\[|\]$/gu, ""),
      port: Number(endpoint.port || (endpoint.protocol === "http:" ? 80 : 443)),
      ...(allowedIps ? { allowed_ips: allowedIps } : {}),
      protocol: "rest",
      enforcement: "enforce",
      rules: [
        { allow: { method: "GET", path: `${prefix}/models` } },
        { allow: { method: "POST", path: `${prefix}/chat/completions` } },
      ],
    },
  ];
  return YAML.stringify(profile);
}

export async function withHermesNativeProfile<T>(
  definition: NativeProviderDefinition,
  use: (profilePath: string) => Promise<T> | T,
): Promise<T> {
  const source = boundHermesNativeProfile(definition);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-profile-"));
  try {
    const profilePath = path.join(directory, `${definition.profileId}.yaml`);
    fs.writeFileSync(profilePath, source, { mode: 0o600 });
    return await use(profilePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
