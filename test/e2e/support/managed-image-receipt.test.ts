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
  selectedE2eManagedImageReference,
  shouldAssertStockManagedImageReceipt,
} from "../fixtures/managed-image-receipt.ts";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import { HostCliClient } from "../fixtures/clients/host.ts";
import { CleanupRegistry } from "../fixtures/cleanup.ts";
import { SecretStore } from "../fixtures/secrets.ts";
import { DEEPAGENTS_FRESH_REONBOARD_CHECK } from "../live/cloud-experimental-check-list.ts";
import { runE2eCloudExperimentalChecks } from "../live/cloud-experimental-checks.ts";
import { readFullE2eColdWorkloadEvidence } from "../live/full-e2e-workload-evidence.ts";
import "../live/dgx-express.test.ts";
import "../../../src/lib/inference/vllm.ts";

const capturedDgx = vi.hoisted(() => ({ test: vi.fn(), run: undefined as unknown }));
vi.mock("../fixtures/e2e-test.ts", async () => ({
  expect: (await import("vitest")).expect,
  test: Object.assign(capturedDgx.test, {
    for: () => (_title: string, _options: object, run: unknown) => {
      capturedDgx.run = run;
    },
  }),
}));
vi.mock("../live/inference-routing-helpers.ts", () => ({
  requireLivePrerequisites: vi.fn(),
  cleanupSandbox: vi.fn(),
  expectOpenAiChatThroughSandbox: vi.fn(),
}));

const SANDBOX_NAME = "managed-only-stock";
const SPARK_SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-spark-vllm";
const REVISION = "d".repeat(40);
const COHORT = "ghrun-32707920950-1";
const REFERENCE = `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${"a".repeat(64)}`;
const ARM64_REFERENCE = `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${"b".repeat(64)}`;
const CATALOG_REFERENCES = {
  openclaw: REFERENCE,
  hermes: `${MANAGED_IMAGE_REPOSITORIES.hermes}@sha256:${"c".repeat(64)}`,
  "langchain-deepagents-code": `${MANAGED_IMAGE_REPOSITORIES["langchain-deepagents-code"]}@sha256:${"e".repeat(64)}`,
} as const;
const temporaryHomes: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of temporaryHomes.splice(0)) {
    fs.rmSync(home, { force: true, recursive: true });
  }
});

function managedReceipt(
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

function candidateInlineCatalogEnvironment(home: string): NodeJS.ProcessEnv {
  const environment = candidateCatalogEnvironment(home);
  const catalogPath = environment.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG!;
  const catalog = fs.readFileSync(catalogPath, "utf8").trim();
  delete environment.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG;
  environment.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON = catalog;
  return environment;
}

function writeRegistry(
  workload: Record<string, unknown> | null,
  agent: keyof typeof CATALOG_REFERENCES = "openclaw",
  sandboxName = SANDBOX_NAME,
): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-only-receipt-"));
  temporaryHomes.push(home);
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

describe("selected E2E managed-image reference", () => {
  it("uses the main-run cohort receipt when no candidate catalog exists (#12421)", () => {
    const home = writeRegistry(managedReceipt());
    const environment = {
      ...selectedEnvironment(home),
      GITHUB_ACTIONS: "true",
      NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON: "",
      NEMOCLAW_RUN_LIVE_E2E: "1",
    };

    expect(
      selectedE2eManagedImageReference({
        environment,
        expectedAgent: "openclaw",
        nodeArchitecture: "x64",
      }),
    ).toBe(REFERENCE);
  });

  it("uses the trusted candidate catalog when no cohort revision exists (#12421)", () => {
    const home = writeRegistry(managedReceipt());

    expect(
      selectedE2eManagedImageReference({
        environment: candidateInlineCatalogEnvironment(home),
        expectedAgent: "openclaw",
        nodeArchitecture: "x64",
      }),
    ).toBe(REFERENCE);
  });

  it("selects the arm64 image from the main-run cohort receipt (#12421)", () => {
    expect(
      selectedE2eManagedImageReference({
        environment: selectedEnvironment("/tmp/unused"),
        expectedAgent: "openclaw",
        nodeArchitecture: "arm64",
      }),
    ).toBe(ARM64_REFERENCE);
  });

  it("rejects a main-run revision without its cohort receipt (#12421)", () => {
    expect(() =>
      selectedE2eManagedImageReference({
        environment: { E2E_MANAGED_IMAGE_REVISION: REVISION },
        expectedAgent: "openclaw",
        nodeArchitecture: "x64",
      }),
    ).toThrow("complete selected managed-image cohort receipt");
  });

  it("rejects a cohort receipt with a malformed image digest (#12421)", () => {
    const environment = selectedEnvironment("/tmp/unused");
    const receipt = JSON.parse(environment.E2E_MANAGED_IMAGE_COHORT_RECEIPT!) as {
      images: { openclaw: { "linux/amd64": string } };
    };
    receipt.images.openclaw["linux/amd64"] =
      `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:not-a-digest`;
    environment.E2E_MANAGED_IMAGE_COHORT_RECEIPT = JSON.stringify(receipt);

    expect(() =>
      selectedE2eManagedImageReference({
        environment,
        expectedAgent: "openclaw",
        nodeArchitecture: "x64",
      }),
    ).toThrow("exact agent image from the selected cohort");
  });

  it("rejects a host architecture that has no managed image (#12421)", () => {
    expect(() =>
      selectedE2eManagedImageReference({
        environment: selectedEnvironment("/tmp/unused"),
        expectedAgent: "openclaw",
        nodeArchitecture: "riscv64",
      }),
    ).toThrow("does not support host architecture 'riscv64'");
  });
});

describe("stock E2E managed-image receipt assertion", () => {
  it.each([
    ["accepts a valid", REVISION, "accepted"],
    [
      "rejects a stale",
      "a".repeat(40),
      `stock sandbox '${SANDBOX_NAME}' managed-image revision does not match the selected cohort`,
    ],
  ])(
    "%s DCode receipt after the fresh re-onboarding script succeeds (#11305)",
    async (_label, revision, expected) => {
      const home = writeRegistry(
        managedReceipt(revision, "langchain-deepagents-code"),
        "langchain-deepagents-code",
      );
      const environment = selectedEnvironment(home);
      vi.stubEnv("HOME", home);
      vi.stubEnv("E2E_MANAGED_IMAGE_REVISION", environment.E2E_MANAGED_IMAGE_REVISION);
      vi.stubEnv("E2E_MANAGED_IMAGE_COHORT_RECEIPT", environment.E2E_MANAGED_IMAGE_COHORT_RECEIPT);
      vi.stubEnv("E2E_WORKLOAD_SOURCE", "managed-image");
      const run = vi.fn(async () => ({
        command: [],
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        artifacts: { stdout: "stdout.txt", stderr: "stderr.txt", result: "result.json" },
      }));
      try {
        await expect(
          runE2eCloudExperimentalChecks(
            "cloud-langchain-deepagents-code",
            SANDBOX_NAME,
            [DEEPAGENTS_FRESH_REONBOARD_CHECK],
            {
              artifacts: new ArtifactSink(path.join(home, "artifacts")),
              cleanup: new CleanupRegistry(),
              host: new HostCliClient({ run }),
              secrets: new SecretStore({}, (note) => {
                throw new Error(note);
              }),
            },
          ).then(
            () => "accepted",
            (error: Error) => error.message,
          ),
        ).resolves.toBe(expected);
        expect(run).toHaveBeenCalledTimes(2);
        expect(run).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({ command: "openshell" }),
          expect.anything(),
        );
        expect(run).toHaveBeenLastCalledWith(
          expect.objectContaining({
            command: "bash",
            args: [path.join(process.cwd(), DEEPAGENTS_FRESH_REONBOARD_CHECK)],
          }),
          expect.anything(),
        );
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

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

  it("accepts the durable receipt from the trusted inline candidate catalog", () => {
    const home = writeRegistry(managedReceipt());

    expect(
      assertStockManagedImageReceipt({
        environment: candidateInlineCatalogEnvironment(home),
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

  it("does not let a local-Dockerfile marker bypass candidate receipt validation", () => {
    const home = writeRegistry({
      schemaVersion: 1,
      kind: "legacy-dockerfile",
      reference: "stock-legacy:latest",
      shared: false,
    });

    expect(() =>
      assertStockManagedImageReceipt({
        environment: {
          ...candidateCatalogEnvironment(home),
          E2E_WORKLOAD_SOURCE: "local-dockerfile",
        },
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

  it("uses managed-image authority for stock onboarding and excludes custom Dockerfiles", () => {
    expect(
      shouldAssertStockManagedImageReceipt("/workspace/bin/nemoclaw.js", ["onboard"], {
        E2E_MANAGED_IMAGE_REVISION: REVISION,
      }),
    ).toBe(true);
    expect(
      shouldAssertStockManagedImageReceipt(
        "node",
        ["/release/bin/nemoclaw.js", "onboard", "--help"],
        { E2E_MANAGED_IMAGE_REVISION: REVISION },
      ),
    ).toBe(false);
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
      shouldAssertStockManagedImageReceipt(
        "node",
        ["/workspace/bin/nemoclaw.js", "onboard", "--help"],
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

describe.each(["fixed-profile", "extra-arguments"] as const)(
  "DGX Spark %s managed-image consumer",
  (variant) => {
    it.each([
      {
        evidence: "cohort",
        workload: () => managedReceipt(),
        environment: selectedEnvironment,
        expected: "selected managed image accepted",
      },
      {
        evidence: "catalog",
        workload: () => managedReceipt(),
        environment: candidateCatalogEnvironment,
        expected: "selected managed image accepted",
      },
      {
        evidence: "wrong revision",
        workload: () => managedReceipt("b".repeat(40)),
        environment: selectedEnvironment,
        expected: "does not match the selected cohort",
      },
      {
        evidence: "wrong image",
        workload: () => ({
          ...managedReceipt(),
          reference: `${MANAGED_IMAGE_REPOSITORIES.openclaw}@sha256:${"9".repeat(64)}`,
        }),
        environment: selectedEnvironment,
        expected: "exact agent image from the selected cohort",
      },
      {
        evidence: "missing workload",
        workload: () => null,
        environment: selectedEnvironment,
        expected: "must record a managed-image receipt",
      },
      {
        evidence: "missing authority",
        workload: () => managedReceipt(),
        environment: (home: string) => ({ HOME: home }),
        expected: "one exact managed-image cohort revision",
      },
    ])("checks $evidence before runtime probes", async ({ workload, environment, expected }) => {
      const home = writeRegistry(workload(), "openclaw", SPARK_SANDBOX_NAME);
      const selected: NodeJS.ProcessEnv = environment(home);
      vi.stubEnv("HOME", home);
      vi.stubEnv("E2E_MANAGED_IMAGE_REVISION", selected.E2E_MANAGED_IMAGE_REVISION ?? "");
      vi.stubEnv(
        "E2E_MANAGED_IMAGE_COHORT_RECEIPT",
        selected.E2E_MANAGED_IMAGE_COHORT_RECEIPT ?? "",
      );
      vi.stubEnv(
        "NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG",
        selected.NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG ?? "",
      );
      vi.stubEnv("NEMOCLAW_E2E_MANAGED_IMAGE_CATALOG_JSON", "");
      vi.stubEnv("NEMOCLAW_E2E_EXPECTED_SHA", REVISION);
      vi.stubEnv("NEMOCLAW_RUN_LIVE_E2E", "1");
      vi.stubEnv("GITHUB_ACTIONS", "true");
      vi.stubEnv("DOCKER_HOST", "");
      vi.stubEnv("DOCKER_CONTEXT", "");
      const result = (stdout = "", exitCode = 0, stderr = "") => ({ stdout, exitCode, stderr });
      const responses: Record<string, ReturnType<typeof result>> = {
        "spark-express-platform": result("DGX Spark"),
        "spark-express-nvidia-smi": result(),
        "spark-extra-arguments-physical-memory": result("63082733568"),
        "preflight-spark-express-vllm-container": result("", 1, "No such container"),
        "preflight-spark-express-sandbox-list": result(),
        "spark-express-vllm-onboard": result(),
        "spark-express-vllm-container-inspect": result(JSON.stringify([{ Id: "a".repeat(64) }])),
        "spark-express-vllm-sandbox-inspect": result(
          JSON.stringify({ id: "05d120e4-484c-47d4-9a59-77a08cbb6e67", name: SPARK_SANDBOX_NAME }),
        ),
      };
      const host = {
        command: vi.fn(
          async (_command: string, _args: string[], options: { artifactName: string }) =>
            responses[options.artifactName] ??
            Promise.reject(new Error(`Unexpected probe: ${options.artifactName}`)),
        ),
      };
      const run = capturedDgx.run as (
        selection: readonly string[],
        fixtures: object,
      ) => Promise<void>;
      const execution = run(
        [
          variant === "extra-arguments" ? "spark-vllm-extra-arguments" : "spark-express-vllm",
          variant,
        ],
        {
          artifacts: { target: { declare: vi.fn() } },
          cleanup: { add: vi.fn() },
          host,
          sandbox: {},
          runtimeProvider: {},
          progress: {
            phase: (phase: string) => {
              expect(phase, "selected managed image accepted").not.toBe(
                "verify selected vLLM runtime configuration",
              );
            },
          },
        },
      );
      await expect(execution).rejects.toThrow(expected);
      expect(host.command).toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "get", "-o", "json", SPARK_SANDBOX_NAME],
        expect.objectContaining({ artifactName: "spark-express-vllm-sandbox-inspect" }),
      );
    });
  },
);
