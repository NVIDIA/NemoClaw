// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { createInMemoryRuntimeProviderBundle } from "../../../test/helpers/runtime-provider-bundle";
import {
  ManagedImageCatalogError,
  ManagedImageCatalogUnavailableError,
} from "./managed-image/catalog";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORMS,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageContractCatalog,
  type ManagedImageContractV1,
  type ManagedImageAgent,
  SHIPPED_MANAGED_IMAGE_AGENTS,
} from "./managed-image/contract";
import { createRuntimeProviderBundleRegistry } from "./runtime-provider/registry";
import {
  liveE2eManagedImageCatalog,
  prepareSandboxWorkloadSource,
  SandboxWorkloadPreparationError,
} from "./workload/preparation";
import { resolveSandboxWorkloadRuntimeCapabilities } from "./workload/runtime";
import type { SandboxWorkloadRuntimeCapabilities } from "./workload/source";

const RELEASE = "v0.0.97";
const MANAGED_IMAGE_PLATFORM = MANAGED_IMAGE_PLATFORMS[0];
const REVISION = "2f03907c37822ea6f1ac9d1bf5c82a4a4568585f";
const COHORT = "ghrun-7744-2";

function contract(agent: ManagedImageAgent, index: number): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digest = `sha256:${String(index + 1).repeat(64)}` as const;
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform: MANAGED_IMAGE_PLATFORM,
    image,
    digest,
    reference: `${image}@${digest}`,
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: REVISION,
      release: RELEASE,
      cohort: COHORT,
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

const CATALOG: ManagedImageContractCatalog = Object.fromEntries(
  SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => [agent, contract(agent, index)]),
);

function runtime(driverName = "docker"): SandboxWorkloadRuntimeCapabilities {
  return {
    driverName,
    managedImageSelectionPolicy: "require-managed",
    legacyDockerfileBuilds: driverName === "docker",
    managedImages: {
      exactDigestReferences: true,
      platforms: [MANAGED_IMAGE_PLATFORM],
      startupProfileContractVersions: [MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION],
      capabilityContractVersions: [MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION],
    },
  };
}

function input(agentName: string) {
  return {
    agentName,
    legacyDockerfilePath: `agents/${agentName}/Dockerfile`,
    runtime: runtime(),
    version: "0.0.97",
  };
}

describe("sandbox workload preparation", () => {
  it("selects an exact embedded catalog only for live PR E2E (#9464)", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-live-e2e-catalog-"));
    const catalogPath = path.join(fixtureRoot, "catalog.json");
    const packagedCatalogPath = path.join(fixtureRoot, "dist", "e2e-managed-image-catalog.json");
    fs.mkdirSync(path.dirname(packagedCatalogPath));
    fs.writeFileSync(catalogPath, "{}\n", { mode: 0o600 });
    fs.writeFileSync(packagedCatalogPath, "{}\n", { mode: 0o600 });
    try {
      expect(
        liveE2eManagedImageCatalog({
          GITHUB_ACTIONS: "true",
          NEMOCLAW_RUN_LIVE_E2E: "1",
          NEMOCLAW_E2E_EXPECTED_SHA: REVISION,
          NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: catalogPath,
        }),
      ).toEqual({ path: catalogPath, revision: REVISION });
      expect(
        liveE2eManagedImageCatalog({
          GITHUB_ACTIONS: "true",
          GITHUB_WORKSPACE: fixtureRoot,
          NEMOCLAW_RUN_LIVE_E2E: "1",
          NEMOCLAW_E2E_EXPECTED_SHA: REVISION,
        }),
      ).toEqual({ path: packagedCatalogPath, revision: REVISION });
      expect(
        liveE2eManagedImageCatalog({
          NEMOCLAW_RUN_LIVE_E2E: "1",
          NEMOCLAW_E2E_EXPECTED_SHA: REVISION,
          NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: catalogPath,
        }),
      ).toBeNull();
      expect(
        liveE2eManagedImageCatalog({
          GITHUB_ACTIONS: "true",
          NEMOCLAW_RUN_LIVE_E2E: "1",
          NEMOCLAW_E2E_EXPECTED_SHA: REVISION,
          NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: path.join(fixtureRoot, "missing.json"),
        }),
      ).toBeNull();
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("rejects an embedded catalog without an exact candidate revision (#9464)", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-live-e2e-catalog-"));
    const catalogPath = path.join(fixtureRoot, "catalog.json");
    fs.writeFileSync(catalogPath, "{}\n", { mode: 0o600 });
    try {
      expect(() =>
        liveE2eManagedImageCatalog({
          GITHUB_ACTIONS: "true",
          NEMOCLAW_RUN_LIVE_E2E: "1",
          NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: catalogPath,
        }),
      ).toThrow("requires an exact candidate revision");
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it.each(SHIPPED_MANAGED_IMAGE_AGENTS)(
    "resolves the complete release catalog and exact %s image (#7744)",
    async (agent) => {
      const resolveCatalog = vi.fn(async () => CATALOG);

      const prepared = await prepareSandboxWorkloadSource(input(agent), { resolveCatalog });

      expect(resolveCatalog).toHaveBeenCalledExactlyOnceWith({
        release: RELEASE,
        platform: MANAGED_IMAGE_PLATFORM,
      });
      expect(prepared).toEqual({
        source: {
          kind: "managed-image",
          reference: contract(agent, SHIPPED_MANAGED_IMAGE_AGENTS.indexOf(agent)).reference,
          contract: contract(agent, SHIPPED_MANAGED_IMAGE_AGENTS.indexOf(agent)),
        },
        release: RELEASE,
        fallbackDiagnostic: null,
      });
    },
  );

  it("passes an immutable qualification revision to catalog resolution (#9385)", async () => {
    const resolveCatalog = vi.fn(async () => CATALOG);

    await prepareSandboxWorkloadSource(
      { ...input("openclaw"), catalogRevision: REVISION },
      { resolveCatalog },
    );

    expect(resolveCatalog).toHaveBeenCalledExactlyOnceWith({
      release: RELEASE,
      platform: MANAGED_IMAGE_PLATFORM,
      revision: REVISION,
    });
  });

  it("uses a resolver-fetched exact-revision catalog when local release labels differ", async () => {
    const resolveCatalog = vi.fn(async () => CATALOG);

    const prepared = await prepareSandboxWorkloadSource(
      { ...input("openclaw"), version: "0.1.0", catalogRevision: REVISION },
      { resolveCatalog },
    );

    expect(resolveCatalog).toHaveBeenCalledExactlyOnceWith({
      release: "v0.1.0",
      platform: MANAGED_IMAGE_PLATFORM,
      revision: REVISION,
    });
    expect(prepared.release).toBe(RELEASE);
    expect(prepared.source).toMatchObject({
      kind: "managed-image",
      contract: { source: { release: RELEASE, revision: REVISION } },
    });
  });

  it("rejects an exact catalog from another PR commit (#9464)", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-catalog-"));
    const catalogPath = path.join(fixtureRoot, "catalog.json");
    fs.writeFileSync(catalogPath, JSON.stringify(CATALOG), { mode: 0o600 });
    try {
      await expect(
        prepareSandboxWorkloadSource({
          ...input("openclaw"),
          catalogPath,
          expectedCatalogRevision: "b".repeat(40),
        }),
      ).rejects.toThrow("does not match the live E2E candidate revision");
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("uses an exact-revision E2E catalog when local git describe labels differ", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-catalog-"));
    const catalogPath = path.join(fixtureRoot, "catalog.json");
    fs.writeFileSync(catalogPath, JSON.stringify(CATALOG), { mode: 0o600 });
    try {
      const prepared = await prepareSandboxWorkloadSource({
        ...input("openclaw"),
        version: "0.1.0",
        catalogPath,
        expectedCatalogRevision: REVISION,
      });

      expect(prepared.release).toBe(RELEASE);
      expect(prepared.source).toMatchObject({
        kind: "managed-image",
        contract: { source: { release: RELEASE, revision: REVISION } },
      });
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("loads an exact local all-agent catalog without using the registry resolver (#7744)", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-catalog-"));
    const catalogPath = path.join(fixtureRoot, "catalog.json");
    const resolveCatalog = vi.fn(async () => CATALOG);
    fs.writeFileSync(catalogPath, JSON.stringify(CATALOG), { mode: 0o600 });
    try {
      const prepared = await prepareSandboxWorkloadSource(
        { ...input("hermes"), catalogPath },
        { resolveCatalog },
      );

      expect(resolveCatalog).not.toHaveBeenCalled();
      expect(prepared.source).toMatchObject({
        kind: "managed-image",
        reference: contract("hermes", 1).reference,
      });
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("rejects a symlinked local managed-image catalog before selection (#7744)", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-catalog-"));
    const catalogPath = path.join(fixtureRoot, "catalog.json");
    const symlinkPath = path.join(fixtureRoot, "catalog-link.json");
    fs.writeFileSync(catalogPath, JSON.stringify(CATALOG), { mode: 0o600 });
    fs.symlinkSync(catalogPath, symlinkPath);
    try {
      await expect(
        prepareSandboxWorkloadSource({ ...input("openclaw"), catalogPath: symlinkPath }),
      ).rejects.toMatchObject({
        message:
          "Sandbox workload preparation failed: managed image catalog 'v0.0.97' failed validation",
        cause: {
          message:
            "Sandbox workload preparation failed: managed image catalog file must be a bounded regular file",
        },
      });
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("never resolves a catalog for an explicit custom Dockerfile (#7744)", async () => {
    const resolveCatalog = vi.fn(async () => CATALOG);
    const prepared = await prepareSandboxWorkloadSource(
      {
        ...input("openclaw"),
        customDockerfilePath: "/workspace/CustomDockerfile",
      },
      { resolveCatalog },
    );

    expect(resolveCatalog).not.toHaveBeenCalled();
    expect(prepared.source).toEqual({
      kind: "legacy-dockerfile",
      dockerfilePath: "/workspace/CustomDockerfile",
      reason: "custom-dockerfile",
    });
  });

  it("does not fetch for a runtime that has not registered managed-image capabilities (#7744)", async () => {
    const resolveCatalog = vi.fn(async () => CATALOG);
    const prepared = await prepareSandboxWorkloadSource(
      {
        ...input("hermes"),
        runtime: {
          driverName: "kubernetes",
          managedImageSelectionPolicy: "prefer-managed",
          legacyDockerfileBuilds: true,
          managedImages: null,
        },
      },
      { resolveCatalog },
    );

    expect(resolveCatalog).not.toHaveBeenCalled();
    expect(prepared.source).toMatchObject({
      kind: "legacy-dockerfile",
      reason: "runtime-unsupported",
    });
  });

  it("selects the managed cohort for Docker on arm64 (#7744)", async () => {
    const arm64Catalog = Object.fromEntries(
      SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => [
        agent,
        { ...contract(agent, index), platform: MANAGED_IMAGE_PLATFORMS[1] },
      ]),
    );
    const resolveCatalog = vi.fn(async () => arm64Catalog);
    const prepared = await prepareSandboxWorkloadSource(
      {
        ...input("openclaw"),
        runtime: resolveSandboxWorkloadRuntimeCapabilities(
          { driverName: "docker" },
          undefined,
          "arm64",
        ),
      },
      { resolveCatalog },
    );

    expect(resolveCatalog).toHaveBeenCalledExactlyOnceWith({
      release: RELEASE,
      platform: MANAGED_IMAGE_PLATFORMS[1],
    });
    expect(prepared.source).toMatchObject({
      kind: "managed-image",
      reference: contract("openclaw", 0).reference,
      contract: { platform: MANAGED_IMAGE_PLATFORMS[1] },
    });
  });

  it("fails closed before catalog access for stock Docker on an unsupported architecture (#7744)", async () => {
    const resolveCatalog = vi.fn(async () => CATALOG);

    await expect(
      prepareSandboxWorkloadSource(
        {
          ...input("openclaw"),
          runtime: resolveSandboxWorkloadRuntimeCapabilities(
            { driverName: "docker" },
            undefined,
            "s390x",
          ),
        },
        { resolveCatalog },
      ),
    ).rejects.toThrow("does not advertise managed images");
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it("rejects custom Dockerfile preparation for a buildless provider before catalog access (#7744)", async () => {
    const driverName = "buildless-test";
    const resolveCatalog = vi.fn(async () => CATALOG);
    const providers = createRuntimeProviderBundleRegistry([
      [
        driverName,
        createInMemoryRuntimeProviderBundle({
          providerId: driverName,
          workloadProfile: {
            support: runtime(driverName).managedImages!,
            hostArchitectures: ["amd64"],
            managedImageSelectionPolicy: "require-managed",
            legacyDockerfileBuilds: false,
          },
        }),
      ],
    ]);

    await expect(
      prepareSandboxWorkloadSource(
        {
          ...input("openclaw"),
          customDockerfilePath: "/workspace/CustomDockerfile",
          runtime: resolveSandboxWorkloadRuntimeCapabilities({ driverName }, providers, "x64"),
        },
        { resolveCatalog },
      ),
    ).rejects.toThrow("cannot use the legacy Dockerfile workload for custom-dockerfile");
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it("fails before catalog access when an incapable runtime requires managed images (#7744)", async () => {
    const resolveCatalog = vi.fn(async () => CATALOG);

    await expect(
      prepareSandboxWorkloadSource(
        {
          ...input("langchain-deepagents-code"),
          runtime: {
            driverName: "buildless-test",
            managedImageSelectionPolicy: "require-managed",
            legacyDockerfileBuilds: false,
            managedImages: null,
          },
        },
        { resolveCatalog },
      ),
    ).rejects.toThrow("does not advertise managed images");
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it("uses an unavailable-catalog fallback only under an explicit preferred policy (#7744)", async () => {
    const resolveCatalog = vi.fn(async () => {
      throw new ManagedImageCatalogUnavailableError("registry offline");
    });
    const preferred = await prepareSandboxWorkloadSource(
      { ...input("openclaw"), policy: "prefer-managed" },
      { resolveCatalog },
    );

    expect(preferred.source).toMatchObject({
      kind: "legacy-dockerfile",
      reason: "contract-unavailable",
    });
    expect(preferred.fallbackDiagnostic).toContain("registry offline");

    await expect(
      prepareSandboxWorkloadSource(input("openclaw"), { resolveCatalog }),
    ).rejects.toThrow(SandboxWorkloadPreparationError);
  });

  it("rejects catalog integrity failures under the preferred policy (#7744)", async () => {
    const resolveCatalog = vi.fn(async () => {
      throw new ManagedImageCatalogError("manifest bytes do not match the selected digest");
    });

    await expect(
      prepareSandboxWorkloadSource(
        { ...input("openclaw"), policy: "prefer-managed" },
        { resolveCatalog },
      ),
    ).rejects.toThrow("managed image catalog 'v0.0.97' failed validation");
  });

  it("rejects an invalid release before preferred-policy catalog fallback (#7744)", async () => {
    const resolveCatalog = vi.fn(async () => CATALOG);

    await expect(
      prepareSandboxWorkloadSource(
        { ...input("openclaw"), version: "../mutable", policy: "prefer-managed" },
        { resolveCatalog },
      ),
    ).rejects.toThrow("managed image release for CLI version '../mutable' failed validation");
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it("does not hide a malformed catalog contract behind preferred fallback (#7744)", async () => {
    const malformed = {
      ...CATALOG,
      hermes: {
        ...contract("hermes", 1),
        reference: `${MANAGED_IMAGE_REPOSITORIES.hermes}:${RELEASE}`,
      },
    };

    await expect(
      prepareSandboxWorkloadSource(input("hermes"), {
        resolveCatalog: async () => malformed,
      }),
    ).rejects.toThrow("failed closed validation");
  });

  it("rejects a catalog that contains only the selected agent (#7744)", async () => {
    await expect(
      prepareSandboxWorkloadSource(input("openclaw"), {
        resolveCatalog: async () => ({ openclaw: contract("openclaw", 0) }),
      }),
    ).rejects.toThrow("catalog is incomplete; 'hermes' is missing");
  });

  it("rejects a complete catalog assembled from different revisions (#7744)", async () => {
    const mixed = {
      ...CATALOG,
      hermes: {
        ...contract("hermes", 1),
        source: {
          ...contract("hermes", 1).source,
          revision: "3f03907c37822ea6f1ac9d1bf5c82a4a4568585f",
        },
      },
    };

    await expect(
      prepareSandboxWorkloadSource(input("hermes"), {
        resolveCatalog: async () => mixed,
      }),
    ).rejects.toThrow("one all-agent source revision");
  });

  it("rejects a complete catalog assembled from different publication cohorts (#7744)", async () => {
    const mixed = {
      ...CATALOG,
      hermes: {
        ...contract("hermes", 1),
        source: {
          ...contract("hermes", 1).source,
          cohort: "ghrun-7744-3",
        },
      },
    };

    await expect(
      prepareSandboxWorkloadSource(input("hermes"), {
        resolveCatalog: async () => mixed,
      }),
    ).rejects.toThrow("one all-agent publication cohort");
  });

  it("rejects a complete catalog whose release identity differs from the requested tag (#7744)", async () => {
    const wrongRelease = {
      ...CATALOG,
      "langchain-deepagents-code": {
        ...contract("langchain-deepagents-code", 2),
        source: {
          ...contract("langchain-deepagents-code", 2).source,
          release: "v0.0.98",
        },
      },
    };

    await expect(
      prepareSandboxWorkloadSource(input("langchain-deepagents-code"), {
        resolveCatalog: async () => wrongRelease,
      }),
    ).rejects.toThrow("belongs to 'v0.0.98', not 'v0.0.97'");
  });

  it("prepares a managed image for an independently registered MXC-shaped runtime without branching (#7744)", async () => {
    const prepared = await prepareSandboxWorkloadSource(
      { ...input("hermes"), runtime: runtime("portable-test") },
      { resolveCatalog: async () => CATALOG },
    );

    expect(prepared.source).toMatchObject({
      kind: "managed-image",
      reference: contract("hermes", 1).reference,
    });
  });

  it("never fetches the all-agent cohort catalog for a gated candidate (#7927)", async () => {
    const resolveCatalog = vi.fn(async () => CATALOG);

    await expect(
      prepareSandboxWorkloadSource(
        { ...input("pi"), acceptedCandidateContract: contract("pi", 3) },
        { resolveCatalog },
      ),
    ).rejects.toThrow("requires an exact managed image catalog file");
    expect(resolveCatalog).not.toHaveBeenCalled();
  });

  it("prepares the exact candidate digest from a supplied catalog file (#7927)", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-candidate-catalog-"));
    const catalogPath = path.join(fixtureRoot, "catalog.json");
    const piContract = contract("pi", 3);
    fs.writeFileSync(catalogPath, JSON.stringify({ pi: piContract }), { mode: 0o600 });

    const prepared = await prepareSandboxWorkloadSource(
      { ...input("pi"), acceptedCandidateContract: piContract, catalogPath },
      { resolveCatalog: async () => CATALOG },
    );

    expect(prepared.source).toMatchObject({
      kind: "managed-image",
      reference: piContract.reference,
    });
  });

  it("refuses a candidate catalog that differs from the accepted receipt (#7927)", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-candidate-catalog-"));
    const catalogPath = path.join(fixtureRoot, "catalog.json");
    const acceptedContract = contract("pi", 3);
    const differentDigest = `sha256:${"5".repeat(64)}` as const;
    const differentContract = {
      ...acceptedContract,
      digest: differentDigest,
      reference: `${acceptedContract.image}@${differentDigest}` as const,
    };
    fs.writeFileSync(catalogPath, JSON.stringify({ pi: differentContract }), { mode: 0o600 });

    try {
      await expect(
        prepareSandboxWorkloadSource({
          ...input("pi"),
          acceptedCandidateContract: acceptedContract,
          catalogPath,
        }),
      ).rejects.toThrow("does not match the accepted qualification receipt");
    } finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it("refuses a candidate catalog entry that claims a shipped agent (#7927)", async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-candidate-catalog-"));
    const catalogPath = path.join(fixtureRoot, "catalog.json");
    fs.writeFileSync(catalogPath, JSON.stringify({ pi: contract("hermes", 1) }), { mode: 0o600 });

    await expect(
      prepareSandboxWorkloadSource({
        ...input("pi"),
        acceptedCandidateContract: contract("pi", 3),
        catalogPath,
      }),
    ).rejects.toThrow(SandboxWorkloadPreparationError);
  });

  it("refuses a candidate while the gate is off (#7927)", async () => {
    await expect(
      prepareSandboxWorkloadSource(
        { ...input("pi"), runtime: runtime("docker") },
        { resolveCatalog: async () => CATALOG },
      ),
    ).rejects.toThrow(
      "the selected agent is a release candidate and candidate selection is disabled",
    );
  });
});
