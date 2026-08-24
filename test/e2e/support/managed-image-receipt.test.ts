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
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
} from "../../../src/lib/onboard/managed-image/contract.ts";
import { encodeManagedStartupProfile } from "../../../src/lib/onboard/managed-startup/profile.ts";
import { nemoclawStateRoot } from "../../../src/lib/state/state-root.ts";
import {
  assertStockManagedImageReceipt,
  shouldAssertStockManagedImageReceipt,
} from "../fixtures/managed-image-receipt.ts";

const SANDBOX_NAME = "managed-only-stock";
const REVISION = "d".repeat(40);
const COHORT = "ghrun-32707920950-1";
const REFERENCE = `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${"a".repeat(64)}`;
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

  it("rejects the stock fallback diagnostic before later probes", () => {
    const home = writeRegistry(managedReceipt());

    expect(() =>
      assertStockManagedImageReceipt({
        commandOutput: "Managed image unavailable; using the trusted Dockerfile recipe.",
        environment: { E2E_MANAGED_IMAGE_REVISION: REVISION, HOME: home },
        sandboxName: SANDBOX_NAME,
      }),
    ).toThrow("fallback diagnostic");
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
    expect(
      shouldAssertStockManagedImageReceipt(
        "/workspace/bin/nemoclaw.js",
        ["onboard", "--from", "/workspace/CustomDockerfile"],
        { E2E_MANAGED_IMAGE_REVISION: REVISION },
      ),
    ).toBe(false);
  });
});
