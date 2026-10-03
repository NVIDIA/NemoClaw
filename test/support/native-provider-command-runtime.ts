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
    if (args[0] !== "provider") return undefined;
    if (args[1] === "profile") return { status: 0, stdout: profileJson, stderr: "" };
    if (args[1] === "get")
      return exists
        ? { status: 0, stdout: metadata, stderr: "" }
        : { status: 1, stdout: "", stderr: "provider not found" };
    if (args[1] === "create") exists = true;
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, profileJson, metadata };
}
