// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  SHIPPED_MANAGED_IMAGE_AGENTS,
} from "../../../src/lib/onboard/managed-image/contract.ts";
import { encodeManagedStartupProfile } from "../../../src/lib/onboard/managed-startup/profile.ts";
import { nemoclawStateRoot } from "../../../src/lib/state/state-root.ts";

export const REVISION = "d".repeat(40);
const COHORT = "ghrun-32707920950-1";
export const REFERENCE = `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${"a".repeat(64)}`;
export const ARM64_REFERENCE = `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${"b".repeat(64)}`;
export const CATALOG_REFERENCES = {
  openclaw: REFERENCE,
  hermes: `${MANAGED_IMAGE_REPOSITORIES.hermes}@sha256:${"c".repeat(64)}`,
  "langchain-deepagents-code": `${MANAGED_IMAGE_REPOSITORIES["langchain-deepagents-code"]}@sha256:${"e".repeat(64)}`,
} as const;

export function managedReceipt(
  sourceRevision = REVISION,
  agent: keyof typeof CATALOG_REFERENCES = "openclaw",
): Record<string, unknown> {
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile(agent));
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference: CATALOG_REFERENCES[agent],
    platform: "linux/amd64",
    release: "v0.0.100",
    sourceRevision,
    sourceCohort: COHORT,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: false,
    shared: true,
  };
}

export function selectedEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    E2E_MANAGED_IMAGE_REVISION: REVISION,
    E2E_MANAGED_IMAGE_COHORT_RECEIPT: JSON.stringify({
      kind: "nemoclaw-managed-image-cohort-receipt-v1",
      cohort: COHORT,
      revision: REVISION,
      runAttempt: 1,
      runId: 32707920950,
      images: {
        openclaw: {
          "linux/amd64": REFERENCE,
          "linux/arm64": ARM64_REFERENCE,
        },
        hermes: {
          "linux/amd64": `${MANAGED_IMAGE_REPOSITORIES.hermes}@sha256:${"c".repeat(64)}`,
          "linux/arm64": `${MANAGED_IMAGE_REPOSITORIES.hermes}@sha256:${"d".repeat(64)}`,
        },
        "langchain-deepagents-code": {
          "linux/amd64": `${MANAGED_IMAGE_REPOSITORIES["langchain-deepagents-code"]}@sha256:${"e".repeat(64)}`,
          "linux/arm64": `${MANAGED_IMAGE_REPOSITORIES["langchain-deepagents-code"]}@sha256:${"f".repeat(64)}`,
        },
      },
    }),
    HOME: home,
  };
}

export function candidateCatalogEnvironment(
  home: string,
  platform: "linux/amd64" | "linux/arm64" = "linux/amd64",
): NodeJS.ProcessEnv {
  const catalog = Object.fromEntries(
    SHIPPED_MANAGED_IMAGE_AGENTS.map((agent) => {
      const reference =
        agent === "openclaw" && platform === "linux/arm64"
          ? ARM64_REFERENCE
          : CATALOG_REFERENCES[agent];
      return [
        agent,
        {
          agent,
          capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
          contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
          digest: reference.slice(reference.indexOf("@") + 1),
          image: MANAGED_IMAGE_REPOSITORIES[agent],
          platform,
          reference,
          source: {
            cohort: COHORT,
            release: "v0.0.100",
            repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
            revision: REVISION,
          },
          startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
        },
      ];
    }),
  );
  const catalogPath = path.join(home, "candidate-managed-image-catalog.json");
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`, "utf8");
  return {
    GITHUB_ACTIONS: "true",
    HOME: home,
    NEMOCLAW_E2E_EXPECTED_SHA: REVISION,
    NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG: catalogPath,
    NEMOCLAW_RUN_LIVE_E2E: "1",
  };
}

export function writeManagedImageRegistry(
  home: string,
  workload: Record<string, unknown> | null,
  agent: keyof typeof CATALOG_REFERENCES,
  sandboxName: string,
): string {
  const stateRoot = nemoclawStateRoot(home, 8080);
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, "sandboxes.json"),
    `${JSON.stringify({
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          agent,
          fromDockerfile: null,
          imageTag: workload?.reference,
          workload,
        },
      },
    })}\n`,
    "utf8",
  );
  return home;
}
