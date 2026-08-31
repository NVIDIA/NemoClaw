// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
import {
  assertStockManagedImageReceipt,
  shouldAssertStockManagedImageReceipt,
} from "../fixtures/managed-image-receipt.ts";
import { readFullE2eColdWorkloadEvidence } from "../live/full-e2e-workload-evidence.ts";

const SANDBOX_NAME = "managed-only-stock";
const REVISION = "d".repeat(40);
const COHORT = "ghrun-32707920950-1";
const REFERENCE = `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${"a".repeat(64)}`;
const CATALOG_REFERENCES = {
  openclaw: REFERENCE,
  hermes: `${MANAGED_IMAGE_REPOSITORIES.hermes}@sha256:${"c".repeat(64)}`,
  "langchain-deepagents-code": `${MANAGED_IMAGE_REPOSITORIES["langchain-deepagents-code"]}@sha256:${"e".repeat(64)}`,
} as const;
const temporaryHomes: string[] = [];

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    fs.rmSync(home, { force: true, recursive: true });
  }
});

function managedReceipt(sourceRevision = REVISION): Record<string, unknown> {
  const encodedProfile = encodeManagedStartupProfile(managedStartupE2eProfile("openclaw"));
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference: REFERENCE,
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

function selectedEnvironment(home: string): NodeJS.ProcessEnv {
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
          "linux/arm64": `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${"b".repeat(64)}`,
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

function candidateCatalogEnvironment(home: string): NodeJS.ProcessEnv {
  const catalog = Object.fromEntries(
    SHIPPED_MANAGED_IMAGE_AGENTS.map((agent) => {
      const reference = CATALOG_REFERENCES[agent];
      return [
        agent,
        {
          agent,
          capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
          contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
          digest: reference.slice(reference.indexOf("@") + 1),
          image: MANAGED_IMAGE_REPOSITORIES[agent],
          platform: "linux/amd64",
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

function writeRegistry(workload: Record<string, unknown>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-only-receipt-"));
  temporaryHomes.push(home);
  const stateRoot = nemoclawStateRoot(home, 8080);
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(
    path.join(stateRoot, "sandboxes.json"),
    `${JSON.stringify({
      sandboxes: {
        [SANDBOX_NAME]: {
          name: SANDBOX_NAME,
          agent: "openclaw",
          fromDockerfile: null,
          imageTag: workload.reference,
          workload,
        },
      },
    })}\n`,
    "utf8",
  );
  return home;
}

describe("stock E2E managed-image receipt assertion", () => {
  it("accepts the durable receipt from the selected cohort revision", () => {
    const home = writeRegistry(managedReceipt());

    expect(
      assertStockManagedImageReceipt({
        environment: selectedEnvironment(home),
        expectedAgent: "openclaw",
        sandboxName: SANDBOX_NAME,
      }),
    ).toMatchObject({ agent: "openclaw", sourceRevision: REVISION });
  });

  it("accepts the durable receipt from the trusted candidate catalog", () => {
    const home = writeRegistry(managedReceipt());

    expect(
      assertStockManagedImageReceipt({
        environment: candidateCatalogEnvironment(home),
        expectedAgent: "openclaw",
        sandboxName: SANDBOX_NAME,
      }),
    ).toMatchObject({ agent: "openclaw", sourceRevision: REVISION });
  });

  it("records local Dockerfile evidence without a managed-image receipt", () => {
    const home = writeRegistry(managedReceipt());

    expect(
      readFullE2eColdWorkloadEvidence(SANDBOX_NAME, false, {
        ...candidateCatalogEnvironment(home),
        E2E_WORKLOAD_SOURCE: "local-dockerfile",
      }),
    ).toMatchObject({ kind: "legacy-dockerfile" });
  });

  it("rejects a candidate catalog whose source revision differs from the exact candidate revision", () => {
    const home = writeRegistry(managedReceipt());
    const environment = candidateCatalogEnvironment(home);
    const catalogPath = environment.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG!;
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Record<
      string,
      { source: { revision: string } }
    >;
    catalog.openclaw!.source.revision = "b".repeat(40);
    catalog.hermes!.source.revision = "b".repeat(40);
    catalog["langchain-deepagents-code"]!.source.revision = "b".repeat(40);
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`, "utf8");

    expect(() =>
      assertStockManagedImageReceipt({
        environment,
        expectedAgent: "openclaw",
        sandboxName: SANDBOX_NAME,
      }),
    ).toThrow("candidate managed-image catalog is invalid");
  });

  it("rejects a candidate catalog that mixes releases", () => {
    const home = writeRegistry(managedReceipt());
    const environment = candidateCatalogEnvironment(home);
    const catalogPath = environment.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG!;
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Record<
      string,
      { source: { release: string } }
    >;
    catalog.hermes!.source.release = "v0.0.101";
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`, "utf8");

    expect(() =>
      assertStockManagedImageReceipt({
        environment,
        expectedAgent: "openclaw",
        sandboxName: SANDBOX_NAME,
      }),
    ).toThrow("candidate managed-image catalog is invalid");
  });

  it("rejects a candidate catalog with an extra agent", () => {
    const home = writeRegistry(managedReceipt());
    const environment = candidateCatalogEnvironment(home);
    const catalogPath = environment.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG!;
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as Record<string, unknown>;
    catalog.extra = catalog.openclaw;
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`, "utf8");

    expect(() =>
      assertStockManagedImageReceipt({
        environment,
        expectedAgent: "openclaw",
        sandboxName: SANDBOX_NAME,
      }),
    ).toThrow("candidate managed-image catalog is invalid");
  });

  it("rejects a candidate catalog that exceeds the size limit", () => {
    const home = writeRegistry(managedReceipt());
    const environment = candidateCatalogEnvironment(home);
    fs.writeFileSync(
      environment.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG!,
      JSON.stringify({ padding: "x".repeat(64 * 1024) }),
      "utf8",
    );

    expect(() =>
      assertStockManagedImageReceipt({
        environment,
        expectedAgent: "openclaw",
        sandboxName: SANDBOX_NAME,
      }),
    ).toThrow("candidate managed-image catalog is invalid");
  });

  it("rejects a durable workload release that differs from the candidate catalog", () => {
    const home = writeRegistry({ ...managedReceipt(), release: "v0.0.101" });

    expect(() =>
      assertStockManagedImageReceipt({
        environment: candidateCatalogEnvironment(home),
        expectedAgent: "openclaw",
        sandboxName: SANDBOX_NAME,
      }),
    ).toThrow("exact agent image from the selected cohort");
  });

  it("does not replace a missing selected-cohort receipt with the candidate catalog", () => {
    const home = writeRegistry(managedReceipt());
    const environment = candidateCatalogEnvironment(home);
    environment.E2E_MANAGED_IMAGE_REVISION = REVISION;

    expect(() =>
      assertStockManagedImageReceipt({
        environment,
        expectedAgent: "openclaw",
        sandboxName: SANDBOX_NAME,
      }),
    ).toThrow("complete selected managed-image cohort receipt");
  });

  it("does not replace a missing selected revision with the candidate catalog", () => {
    const home = writeRegistry(managedReceipt());
    const environment = candidateCatalogEnvironment(home);
    environment.E2E_MANAGED_IMAGE_COHORT_RECEIPT =
      selectedEnvironment(home).E2E_MANAGED_IMAGE_COHORT_RECEIPT;

    expect(() =>
      assertStockManagedImageReceipt({
        environment,
        expectedAgent: "openclaw",
        sandboxName: SANDBOX_NAME,
      }),
    ).toThrow("complete selected managed-image cohort receipt");
  });

  it("rejects a stock legacy Dockerfile receipt", () => {
    const home = writeRegistry({
      schemaVersion: 1,
      kind: "legacy-dockerfile",
      reference: "stock-legacy:latest",
      shared: false,
    });

    expect(() =>
      assertStockManagedImageReceipt({
        environment: { E2E_MANAGED_IMAGE_REVISION: REVISION, HOME: home },
        sandboxName: SANDBOX_NAME,
      }),
    ).toThrow("must record a managed-image receipt");
  });

  it("rejects a managed receipt from another cohort revision", () => {
    const home = writeRegistry(managedReceipt("b".repeat(40)));

    expect(() =>
      assertStockManagedImageReceipt({
        environment: { E2E_MANAGED_IMAGE_REVISION: REVISION, HOME: home },
        sandboxName: SANDBOX_NAME,
      }),
    ).toThrow("does not match the selected cohort");
  });

  it("rejects the selected revision with another publication cohort", () => {
    const home = writeRegistry({ ...managedReceipt(), sourceCohort: "ghrun-999-1" });

    expect(() =>
      assertStockManagedImageReceipt({
        environment: selectedEnvironment(home),
        expectedAgent: "openclaw",
        sandboxName: SANDBOX_NAME,
      }),
    ).toThrow("exact agent image from the selected cohort");
  });

  it("rejects the selected revision with another immutable image reference", () => {
    const home = writeRegistry({
      ...managedReceipt(),
      reference: `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${"9".repeat(64)}`,
    });

    expect(() =>
      assertStockManagedImageReceipt({
        environment: selectedEnvironment(home),
        expectedAgent: "openclaw",
        sandboxName: SANDBOX_NAME,
      }),
    ).toThrow("exact agent image from the selected cohort");
  });

  it("rejects a cohort receipt that maps the stock agent to another repository", () => {
    const home = writeRegistry(managedReceipt());
    const environment = selectedEnvironment(home);
    const receipt = JSON.parse(environment.E2E_MANAGED_IMAGE_COHORT_RECEIPT!) as {
      images: Record<string, Record<string, string>>;
    };
    receipt.images.openclaw["linux/amd64"] =
      `${MANAGED_IMAGE_REPOSITORIES.hermes}@sha256:${"c".repeat(64)}`;
    environment.E2E_MANAGED_IMAGE_COHORT_RECEIPT = JSON.stringify(receipt);

    expect(() =>
      assertStockManagedImageReceipt({
        environment,
        expectedAgent: "openclaw",
        sandboxName: SANDBOX_NAME,
      }),
    ).toThrow("exact agent image from the selected cohort");
  });

  it("rejects a platform reference that differs from the durable workload", () => {
    const home = writeRegistry({ ...managedReceipt(), platform: "linux/arm64" });

    expect(() =>
      assertStockManagedImageReceipt({
        environment: selectedEnvironment(home),
        expectedAgent: "openclaw",
        sandboxName: SANDBOX_NAME,
      }),
    ).toThrow("exact agent image from the selected cohort");
  });

  it("asserts normal stock onboarding and excludes an explicit custom Dockerfile", () => {
    expect(
      shouldAssertStockManagedImageReceipt("/workspace/bin/nemoclaw.js", ["onboard"], {
        E2E_MANAGED_IMAGE_REVISION: REVISION,
      }),
    ).toBe(true);
    expect(
      shouldAssertStockManagedImageReceipt("/workspace/bin/nemoclaw.js", ["onboard"], {
        E2E_MANAGED_IMAGE_REVISION: REVISION,
        NEMOCLAW_FROM_DOCKERFILE: "/workspace/CustomDockerfile",
      }),
    ).toBe(false);
    const home = writeRegistry(managedReceipt());
    expect(
      shouldAssertStockManagedImageReceipt(
        "/workspace/bin/nemoclaw.js",
        ["onboard"],
        candidateCatalogEnvironment(home),
      ),
    ).toBe(true);
    const nonLiveEnvironment = candidateCatalogEnvironment(home);
    nonLiveEnvironment.GITHUB_ACTIONS = "false";
    expect(
      shouldAssertStockManagedImageReceipt(
        "/workspace/bin/nemoclaw.js",
        ["onboard"],
        nonLiveEnvironment,
      ),
    ).toBe(false);
    expect(
      shouldAssertStockManagedImageReceipt(
        "/workspace/bin/nemoclaw.js",
        ["onboard", "--from", "/workspace/CustomDockerfile"],
        { E2E_MANAGED_IMAGE_REVISION: REVISION },
      ),
    ).toBe(false);
    expect(
      shouldAssertStockManagedImageReceipt("/workspace/bin/nemoclaw.js", ["onboard"], {
        E2E_MANAGED_IMAGE_REVISION: REVISION,
        NEMOCLAW_AGENT: "pi",
      }),
    ).toBe(false);
  });
});
