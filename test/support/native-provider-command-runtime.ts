// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { nativeHostedProfile } from "../../src/lib/inference/native-hosted/profiles";

/** Shared CLI boundary fixture for native onboarding and credential handoff. */
export function createNativeProviderCommandRuntime(
  logicalProvider: string,
  initiallyExists = false,
) {
  const profile = nativeHostedProfile(logicalProvider);
  if (!profile) throw new Error(`Unknown native fixture provider: ${logicalProvider}`);
  const profileJson = JSON.stringify(
    parseYaml(
      fs.readFileSync(
        path.join(
          import.meta.dirname,
          "../../managed-inference/provider-profiles",
          `${profile.profileId}.yaml`,
        ),
        "utf8",
      ),
    ),
  );
  const metadata = [
    `Name: ${profile.providerName}`,
    `Type: ${profile.profileId}`,
    "Id: 11111111-2222-4333-8444-555555555555",
    "Resource version: 1",
    `Credential keys: ${profile.credentialEnv}`,
    "Config keys: <none>",
  ].join("\n");
  let exists = initiallyExists;
  const run = (args: string[]) => {
    if (args[0] === "settings" && args[1] === "get") {
      const output = JSON.stringify({
        scope: "global",
        settings: { providers_v2_enabled: "true" },
      });
      return { status: 0, output, stdout: output, stderr: "" };
    }
    if (args[0] !== "provider") return undefined;
    if (args[1] === "profile")
      return { status: 0, output: profileJson, stdout: profileJson, stderr: "" };
    if (args[1] === "list")
      return {
        status: 0,
        output: JSON.stringify(
          exists ? [{ name: profile.providerName, credential_keys: [profile.credentialEnv] }] : [],
        ),
        stdout: JSON.stringify(
          exists ? [{ name: profile.providerName, credential_keys: [profile.credentialEnv] }] : [],
        ),
        stderr: "",
      };
    if (args[1] === "get")
      return exists
        ? { status: 0, output: metadata, stdout: metadata, stderr: "" }
        : { status: 1, output: "provider not found", stdout: "", stderr: "provider not found" };
    if (args[1] === "create") exists = true;
    return { status: 0, output: "", stdout: "", stderr: "" };
  };
  return { run, profileJson, metadata };
}
