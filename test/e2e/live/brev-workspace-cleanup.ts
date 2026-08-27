// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { BrevLaunchableFixture, type BrevWorkspaceOwnership } from "../fixtures/brev-launchable.ts";
import { HostCliClient } from "../fixtures/clients/host.ts";
import { startTestProgress } from "../fixtures/progress.ts";
import { SecretStore } from "../fixtures/secrets.ts";
import { ShellProbe } from "../fixtures/shell-probe.ts";

export async function removePersistedWorkspace(): Promise<void> {
  const ownershipFile = requiredAbsolutePath("BREV_WORKSPACE_OWNERSHIP_FILE");
  if (!fs.existsSync(ownershipFile)) return;
  const artifactDir = requiredAbsolutePath("E2E_ARTIFACT_DIR");
  const ownership = JSON.parse(fs.readFileSync(ownershipFile, "utf8")) as BrevWorkspaceOwnership;
  const artifacts = new ArtifactSink(artifactDir);
  const secrets = new SecretStore(process.env, (message) => {
    throw new Error(message ?? "required cleanup secret is missing");
  });
  const progress = startTestProgress("Brev workspace cleanup", [
    "load the workflow ownership receipt",
    "remove the owned Brev workspace",
  ]);
  progress.phase("remove the owned Brev workspace");
  const shellProbe = new ShellProbe({
    artifacts,
    progress,
    redact: (text) => secrets.redact(text),
    signal: new AbortController().signal,
  });
  try {
    await new BrevLaunchableFixture({
      artifacts,
      host: new HostCliClient(shellProbe),
      ownershipFile,
      secrets,
    }).delete(ownership);
  } finally {
    progress.stop();
  }
}

function requiredAbsolutePath(name: string): string {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}
