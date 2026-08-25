// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { ArtifactSink } from "../../test/e2e/fixtures/artifacts.ts";
import {
  BrevLaunchableFixture,
  type BrevWorkspaceOwnership,
} from "../../test/e2e/fixtures/brev-launchable.ts";
import { HostCliClient } from "../../test/e2e/fixtures/clients/host.ts";
import { startTestProgress } from "../../test/e2e/fixtures/progress.ts";
import { SecretStore } from "../../test/e2e/fixtures/secrets.ts";
import { ShellProbe } from "../../test/e2e/fixtures/shell-probe.ts";

const ownershipFile = requirePath("BREV_WORKSPACE_OWNERSHIP_FILE");
const artifactDir = requirePath("E2E_ARTIFACT_DIR");
if (!fs.existsSync(ownershipFile)) process.exit(0);
const ownership = JSON.parse(fs.readFileSync(ownershipFile, "utf8")) as BrevWorkspaceOwnership;
const artifacts = new ArtifactSink(artifactDir);
const secrets = new SecretStore(process.env, (message) => {
  throw new Error(message ?? "required cleanup secret is missing");
});
const signal = new AbortController().signal;
const progress = startTestProgress("Brev workspace cleanup", ["remove the owned Brev workspace"]);
progress.phase("remove the owned Brev workspace");
const shellProbe = new ShellProbe({
  artifacts,
  progress,
  redact: (text) => secrets.redact(text),
  signal,
});
const host = new HostCliClient(shellProbe);
const fixture = new BrevLaunchableFixture({ artifacts, host, ownershipFile, secrets });
try {
  await fixture.delete(ownership);
} finally {
  progress.stop();
}

function requirePath(name: string): string {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}
