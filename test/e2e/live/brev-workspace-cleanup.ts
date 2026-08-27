// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { BrevLaunchableFixture, type BrevWorkspaceOwnership } from "../fixtures/brev-launchable.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import type { SecretStore } from "../fixtures/secrets.ts";

interface CleanupResources {
  artifacts: ArtifactSink;
  host: HostCliClient;
  progress: TestProgress;
  secrets: SecretStore;
}

export async function removePersistedWorkspace(resources: CleanupResources): Promise<void> {
  const ownershipFile = requiredAbsolutePath("BREV_WORKSPACE_OWNERSHIP_FILE");
  if (!fs.existsSync(ownershipFile)) return;
  resources.progress.phase("load the workflow ownership receipt");
  const ownership = JSON.parse(fs.readFileSync(ownershipFile, "utf8")) as BrevWorkspaceOwnership;
  resources.progress.phase("remove the owned Brev workspace");
  await new BrevLaunchableFixture({
    artifacts: resources.artifacts,
    host: resources.host,
    ownershipFile,
    secrets: resources.secrets,
  }).delete(ownership);
}

function requiredAbsolutePath(name: string): string {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}
