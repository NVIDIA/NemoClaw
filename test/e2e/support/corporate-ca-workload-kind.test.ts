// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
} from "../../../src/lib/onboard/managed-image/contract.ts";
import { encodeManagedStartupProfile } from "../../../src/lib/onboard/managed-startup/profile.ts";
import { nemoclawStateRoot } from "../../../src/lib/state/state-root.ts";
import { registeredCorporateCaWorkloadKind } from "../fixtures/corporate-ca.ts";
import { createPublicInstallWorkspace } from "../fixtures/public-install-workspace.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { connectManagedOpenShellSdk } from "../../../src/lib/adapters/openshell/sdk.ts";

const SANDBOX_NAME = "corporate-ca-authority";
const GATEWAY_PORT = 7443;
const temporaryHomes: string[] = [];

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    fs.rmSync(home, { force: true, recursive: true });
  }
});

describe("corporate CA public installer workspace", () => {
  it.each([
    { mode: 0o700, accepted: true, label: "accepts a private fixture home" },
    { mode: 0o777, accepted: false, label: "rejects fixture homes with writable ancestors" },
  ])("$label", async ({ mode, accepted }) => {
    const cleanup = new CleanupRegistry();
    const workspace = createPublicInstallWorkspace(cleanup);
    try {
      fs.chmodSync(workspace, mode);
      const home = path.join(workspace, "home");
      const stateDir = path.join(home, ".local/state/nemoclaw/openshell-docker-gateway");
      fs.mkdirSync(path.join(stateDir, "tls/client"), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(stateDir, "tls/ca.crt"), "fixture-ca", { mode: 0o600 });
      fs.writeFileSync(path.join(stateDir, "tls/client/tls.crt"), "fixture-cert", { mode: 0o600 });
      fs.writeFileSync(path.join(stateDir, "tls/client/tls.key"), "fixture-key", { mode: 0o600 });
      const connect = vi.fn(async () => ({}));
      const outcome = await connectManagedOpenShellSdk(
        { kind: "named", gatewayName: "nemoclaw" },
        { env: { HOME: home }, loadSdk: async () => ({ OpenShellClient: { connect } }) },
      ).then(
        () => ({ accepted: true, error: "" }),
        (error: Error) => ({ accepted: false, error: error.message }),
      );
      expect(outcome.accepted).toBe(accepted);
      expect(connect).toHaveBeenCalledTimes(accepted ? 1 : 0);
      expect(outcome.error).toEqual(
        accepted ? "" : expect.stringContaining("without group or world write access"),
      );
    } finally {
      expect((await cleanup.runAll()).failures).toEqual([]);
    }
  });
});

function writeRegistry(entry: Record<string, unknown> | null): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-corporate-ca-authority-"));
  temporaryHomes.push(home);
  const stateRoot = nemoclawStateRoot(home, GATEWAY_PORT);
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, "sandboxes.json"),
    `${JSON.stringify({ sandboxes: entry === null ? {} : { [SANDBOX_NAME]: entry } })}\n`,
    "utf8",
  );
  return home;
}

function managedRegistryEntry(): Record<string, unknown> {
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile("openclaw"));
  const reference = `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${"a".repeat(64)}`;
  return {
    name: SANDBOX_NAME,
    agent: "openclaw",
    fromDockerfile: null,
    imageTag: reference,
    workload: {
      schemaVersion: 1,
      kind: "managed-image",
      reference,
      platform: "linux/amd64",
      release: "v0.0.100",
      sourceRevision: "d".repeat(40),
      sourceCohort: "ghrun-9357-1",
      capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
      startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
      encodedProfile,
      startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
      credentialProxyReplayRequired: false,
      shared: true,
    },
  };
}

describe("corporate CA registered workload selection", () => {
  it("selects managed assertions only from validated managed workload authority", () => {
    const home = writeRegistry(managedRegistryEntry());

    expect(registeredCorporateCaWorkloadKind(SANDBOX_NAME, home, GATEWAY_PORT)).toBe(
      "managed-image",
    );
  });

  it("preserves the registered legacy Dockerfile assertion path", () => {
    const home = writeRegistry({
      name: SANDBOX_NAME,
      agent: null,
      fromDockerfile: "/tmp/Dockerfile",
      imageTag: "corporate-ca-legacy:local",
      workload: {
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: "corporate-ca-legacy:local",
        shared: false,
      },
    });

    expect(registeredCorporateCaWorkloadKind(SANDBOX_NAME, home, GATEWAY_PORT)).toBe(
      "legacy-dockerfile",
    );
  });

  it("fails closed when the sandbox is missing from the selected registry", () => {
    const home = writeRegistry(null);

    expect(() => registeredCorporateCaWorkloadKind(SANDBOX_NAME, home, GATEWAY_PORT)).toThrow(
      /missing from the registry/u,
    );
  });

  it("fails closed on a malformed registered workload receipt", () => {
    const home = writeRegistry({
      name: SANDBOX_NAME,
      agent: null,
      fromDockerfile: "/tmp/Dockerfile",
      imageTag: "corporate-ca-legacy:local",
      workload: {
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: "corporate-ca-legacy:local",
        shared: true,
      },
    });

    expect(() => registeredCorporateCaWorkloadKind(SANDBOX_NAME, home, GATEWAY_PORT)).toThrow(
      /no supported registered workload authority/u,
    );
  });
});
