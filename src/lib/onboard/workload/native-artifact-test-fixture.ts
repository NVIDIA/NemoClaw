// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
  NATIVE_ARTIFACT_SOURCE_REPOSITORY,
  NATIVE_ARTIFACT_WORKLOAD_AGENT,
  NATIVE_ARTIFACT_WORKLOAD_CONTRACT_VERSION,
  NATIVE_ARTIFACT_WORKLOAD_PLATFORM,
  NATIVE_ARTIFACT_WORKLOAD_RECEIPT_SCHEMA_VERSION,
  type NativeArtifactWorkloadReceiptV1,
} from "./native-artifact";

export function nativeArtifactWorkloadReceiptFixture(
  encodedProfile: string,
): NativeArtifactWorkloadReceiptV1 {
  return {
    schemaVersion: NATIVE_ARTIFACT_WORKLOAD_RECEIPT_SCHEMA_VERSION,
    kind: "native-artifact",
    contractVersion: NATIVE_ARTIFACT_WORKLOAD_CONTRACT_VERSION,
    agent: NATIVE_ARTIFACT_WORKLOAD_AGENT,
    platform: NATIVE_ARTIFACT_WORKLOAD_PLATFORM,
    artifact: {
      digest: `sha256:${"a".repeat(64)}`,
      version: "2026.7.1",
      source: {
        repository: NATIVE_ARTIFACT_SOURCE_REPOSITORY,
        revision: "b".repeat(40),
      },
    },
    launch: {
      executable: {
        relativePath: "node/node.exe",
        digest: `sha256:${"c".repeat(64)}`,
      },
      arguments: ["openclaw.mjs", "gateway"],
      workingDirectory: ".",
      environmentNames: ["PATH"],
    },
    startupProfileContractVersion: MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: true,
    shared: true,
  };
}
