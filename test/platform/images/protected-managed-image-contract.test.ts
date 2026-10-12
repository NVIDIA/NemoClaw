// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { inspectProtectedDcodeBase } from "../../../scripts/checks/protected-dcode-base-receipt.mts";

import {
  CANDIDATE_MANAGED_IMAGE_AGENTS,
  SHIPPED_MANAGED_IMAGE_AGENTS,
} from "../../../src/lib/onboard/managed-image/contract.ts";
import {
  PROTECTED_MANAGED_IMAGE_ACTIVATION_PATH,
  PROTECTED_MANAGED_IMAGE_AGENTS,
  PROTECTED_MANAGED_IMAGE_MULTIARCH_JOB_ID,
  PROTECTED_MANAGED_IMAGE_PLATFORMS,
  type ProtectedManagedImagePlatform,
  parseProtectedManagedImageActivation,
  parseProtectedManagedImageContracts,
  parseProtectedManagedImageEvidence,
} from "../../../scripts/checks/protected-managed-image-contract.ts";

const BASE_REPOSITORIES = {
  openclaw: "sandbox-base",
  hermes: "hermes-sandbox-base",
  "langchain-deepagents-code": "langchain-deepagents-code-sandbox-base",
} as const;

function contracts(platform: ProtectedManagedImagePlatform) {
  return PROTECTED_MANAGED_IMAGE_AGENTS.map((agent, index) => {
    const digit = String(index + 1);
    const digest = `sha256:${digit.repeat(64)}`;
    return {
      agent,
      baseReference: `ghcr.io/nvidia/nemoclaw/${BASE_REPOSITORIES[agent]}@sha256:${String(index + 4).repeat(64)}`,
      digest,
      localContentId: `sha256:${String(index + 7).repeat(64)}`,
      platform,
      reference: `localhost:5000/nemoclaw-managed-protected/${agent}@${digest}`,
    };
  });
}

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const WORKFLOW_SHA = "c".repeat(40);
const COHORT = "protected-42-1";
const ROOT = path.resolve(import.meta.dirname, "../../..");
const REVIEWED_HERMES_INDEX = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"9".repeat(64)}`;
const PLATFORM_DIGESTS = {
  openclaw: `sha256:${"1".repeat(64)}`,
  hermes: `sha256:${"2".repeat(64)}`,
  dcode: `sha256:${"3".repeat(64)}`,
} as const;
const DCODE_BASE_REF = `ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base@${PLATFORM_DIGESTS.dcode}`;
const E2E_WORKFLOW = YAML.parse(
  readFileSync(path.join(ROOT, ".github", "workflows", "e2e.yaml"), "utf8"),
) as {
  jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
};

function workflowStep(jobId: string, stepName: string): string {
  const run = E2E_WORKFLOW.jobs?.[jobId]?.steps?.find(
    (candidate) => candidate.name === stepName,
  )?.run;
  expect(run, `${jobId} must contain step ${stepName}`).toBeTypeOf("string");
  return run ?? "";
}

type BaseResolutionOptions = {
  candidate?: string;
  localBases?: boolean;
  env?: Record<string, string>;
  publishedAgent?: (typeof PROTECTED_MANAGED_IMAGE_AGENTS)[number];
  mutate?: (cache: string) => void;
};

function candidateBase(cache: string, agent: (typeof PROTECTED_MANAGED_IMAGE_AGENTS)[number]) {
  const name = agent === "langchain-deepagents-code" ? "dcode" : agent;
  const layout = path.join(cache, `${name}-base`);
  mkdirSync(path.join(layout, "blobs/sha256"), { recursive: true });
  function blob(value: unknown, mediaType: string) {
    const bytes = Buffer.from(JSON.stringify(value));
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    writeFileSync(path.join(layout, "blobs/sha256", digest.slice(7)), bytes);
    return { digest, size: bytes.length, mediaType };
  }
  const config = blob(
    {
      os: "linux",
      architecture: "amd64",
      config: {
        Labels: {
          "org.opencontainers.image.revision": HEAD_SHA,
          "org.opencontainers.image.source": "https://github.com/NVIDIA/NemoClaw",
          "io.nvidia.nemoclaw.managed-image.cohort": COHORT,
          "io.nvidia.nemoclaw.agent": agent,
        },
      },
    },
    "application/vnd.oci.image.config.v1+json",
  );
  const manifest = blob(
    {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config,
      layers: [],
    },
    "application/vnd.oci.image.manifest.v1+json",
  );
  writeFileSync(
    path.join(layout, "index.json"),
    JSON.stringify({ schemaVersion: 2, manifests: [manifest] }),
  );
  writeFileSync(path.join(layout, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  const receipt = inspectProtectedDcodeBase(
    layout,
    {
      sourceRevision: HEAD_SHA,
      workflowSha: WORKFLOW_SHA,
      cohort: COHORT,
      platform: "linux/amd64",
    },
    agent,
  );
  writeFileSync(path.join(cache, `${name}-base-receipt.json`), JSON.stringify(receipt));
  return receipt.reference;
}

function runBaseResolution(jobId: string, stepName: string, options: BaseResolutionOptions = {}) {
  const fixture = mkdtempSync(path.join(tmpdir(), "nemoclaw-protected-bases-"));
  const fakeBin = path.join(fixture, "bin");
  const outputPath = path.join(fixture, "github-output");
  const runnerTemp = path.join(fixture, "runner-temp");
  mkdirSync(path.join(fixture, "agents", "hermes"), { recursive: true });
  mkdirSync(fakeBin);
  mkdirSync(runnerTemp);
  writeFileSync(outputPath, "");
  const dockerLog = path.join(fixture, "docker-log");
  writeFileSync(dockerLog, "");
  const references = PROTECTED_MANAGED_IMAGE_AGENTS.map((agent, index) => {
    return options.localBases && options.publishedAgent !== agent
      ? candidateBase(fixture, agent)
      : `ghcr.io/nvidia/nemoclaw/${BASE_REPOSITORIES[agent]}@${Object.values(PLATFORM_DIGESTS)[index]}`;
  });
  writeFileSync(
    path.join(fixture, "prepared-inputs"),
    [HEAD_SHA, "linux/amd64", ...references].join(" ") + "\n",
  );
  writeFileSync(
    path.join(fixture, "agents", "hermes", "Dockerfile"),
    `ARG BASE_IMAGE=${REVIEWED_HERMES_INDEX}\n`,
  );
  const dockerPath = path.join(fakeBin, "docker");
  writeFileSync(
    dockerPath,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$DOCKER_LOG"
ref="$4"
case "$ref" in
  ghcr.io/nvidia/nemoclaw/hermes-sandbox-base:latest) exit 97 ;;
  ghcr.io/nvidia/nemoclaw/sandbox-base:latest) digest='${PLATFORM_DIGESTS.openclaw}' ;;
  '${REVIEWED_HERMES_INDEX}') digest='${PLATFORM_DIGESTS.hermes}' ;;
  ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest) digest='${PLATFORM_DIGESTS.dcode}' ;;
  *@sha256:*) printf '%s\n' '{"kind":"exact"}'; exit 0 ;;
  *) exit 98 ;;
esac
printf '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"digest":"%s","platform":{"os":"linux","architecture":"amd64"}}]}\n' "$digest"
`,
  );
  chmodSync(dockerPath, 0o700);
  const sha256sumPath = path.join(fakeBin, "sha256sum");
  writeFileSync(
    sha256sumPath,
    `#!/bin/sh
set -eu
case "$1" in
  *openclaw-exact.raw) digest='${PLATFORM_DIGESTS.openclaw.slice("sha256:".length)}' ;;
  *hermes-exact.raw) digest='${PLATFORM_DIGESTS.hermes.slice("sha256:".length)}' ;;
  *dcode-exact.raw) digest='${PLATFORM_DIGESTS.dcode.slice("sha256:".length)}' ;;
  *) exit 99 ;;
esac
printf '%s  %s\n' "$digest" "$1"
`,
  );
  chmodSync(sha256sumPath, 0o700);

  try {
    options.mutate?.(fixture);
    const result = spawnSync("bash", ["-c", workflowStep(jobId, stepName)], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        CANDIDATE_BASES: options.candidate ?? "false",
        CHECKOUT_SHA: HEAD_SHA,
        DOCKER_LOG: dockerLog,
        DCODE_BASE_CONTRACT: JSON.stringify({
          platformReferences: { "linux/amd64": DCODE_BASE_REF },
        }),
        DCODE_BASE_REF,
        GITHUB_OUTPUT: outputPath,
        HERMES_BASE_REF: `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${PLATFORM_DIGESTS.hermes}`,
        NEMOCLAW_PROTECTED_MANAGED_IMAGE_BUILD_CACHE: fixture,
        NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA: WORKFLOW_SHA,
        NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT: COHORT,
        NEMOCLAW_PROTECTED_MANAGED_IMAGE_PLATFORM: "linux/amd64",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        PLATFORM: "linux/amd64",
        RUNNER_TEMP: runnerTemp,
        ...options.env,
      },
    });
    return {
      result,
      output: readFileSync(outputPath, "utf8"),
      dockerCalls: readFileSync(dockerLog, "utf8"),
      references,
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function evidence(platform: ProtectedManagedImagePlatform) {
  const built = contracts(platform);
  return {
    baseSha: BASE_SHA,
    cohort: COHORT,
    contracts: built,
    contractSha256: `sha256:${"d".repeat(64)}`,
    directRuns: built.map(({ agent, digest, reference }) => ({
      agent,
      digest,
      platform,
      reference,
    })),
    headSha: HEAD_SHA,
    kind: "nemoclaw-protected-managed-image-multiarch-v1",
    platform,
    run: { attempt: 1, id: 42 },
    workflowSha: WORKFLOW_SHA,
  };
}

function evidenceIdentity(platform: ProtectedManagedImagePlatform) {
  return {
    baseSha: BASE_SHA,
    cohort: COHORT,
    headSha: HEAD_SHA,
    platform,
    runAttempt: 1,
    runId: 42,
    workflowSha: WORKFLOW_SHA,
  };
}

describe("protected managed-image build contract", () => {
  it.each([
    ["managed-image-multiarch-startup", "Resolve digest-pinned platform base images"],
    ["managed-image-protected-runtime", "Resolve digest-pinned amd64 runtime base images"],
  ])("%s keeps immutable DCode resolution separate from Hermes", (jobId, stepName) => {
    const { result, output } = runBaseResolution(jobId, stepName);
    expect(result.status, result.stderr).toBe(0);
    expect(
      Object.fromEntries(
        output
          .trim()
          .split("\n")
          .map((line) => line.split("=")),
      ),
    ).toEqual({
      dcode: `ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base@${PLATFORM_DIGESTS.dcode}`,
      openclaw: `ghcr.io/nvidia/nemoclaw/sandbox-base@${PLATFORM_DIGESTS.openclaw}`,
      hermes: `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@${PLATFORM_DIGESTS.hermes}`,
    });
  });

  it("selects all candidate bases on CPU without resolving published images", () => {
    const { result, output, dockerCalls } = runBaseResolution(
      "managed-image-multiarch-startup",
      "Resolve digest-pinned platform base images",
      { candidate: "true" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(output).toBe("openclaw=candidate\nhermes=candidate\ndcode=candidate\n");
    expect(dockerCalls).toBe("");
  });

  it.each(["managed-image-multiarch-startup", "managed-image-protected-runtime"])(
    "rejects an invalid candidate selection in %s",
    (jobId) => {
      const stepName =
        jobId === "managed-image-multiarch-startup"
          ? "Resolve digest-pinned platform base images"
          : "Resolve digest-pinned amd64 runtime base images";
      const { result, output, dockerCalls } = runBaseResolution(jobId, stepName, {
        candidate: "yes",
      });
      expect(result.status).not.toBe(0);
      expect(output).toBe("");
      expect(dockerCalls).toBe("");
    },
  );

  it("verifies all candidate OCI bases on GPU without registry access", () => {
    const { result, output, dockerCalls, references } = runBaseResolution(
      "managed-image-protected-runtime",
      "Resolve digest-pinned amd64 runtime base images",
      { candidate: "true", localBases: true },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(output).toBe(
      `openclaw=${references[0]}\nhermes=${references[1]}\ndcode=${references[2]}\n`,
    );
    expect(dockerCalls).toBe("");
  });

  it.each(PROTECTED_MANAGED_IMAGE_AGENTS)(
    "rejects a published %s base in a PR cache",
    (publishedAgent) => {
      const { result, dockerCalls } = runBaseResolution(
        "managed-image-protected-runtime",
        "Resolve digest-pinned amd64 runtime base images",
        { candidate: "true", localBases: true, publishedAgent },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("does not match the selected source");
      expect(dockerCalls).toBe("");
    },
  );

  it.each<Record<string, string>>([
    { CHECKOUT_SHA: "d".repeat(40) },
    { NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA: "d".repeat(40) },
    { NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT: "protected-42-2" },
    { NEMOCLAW_PROTECTED_MANAGED_IMAGE_PLATFORM: "linux/arm64" },
  ])("rejects a GPU handoff for another dispatch: %j", (env) => {
    const { result, output, dockerCalls } = runBaseResolution(
      "managed-image-protected-runtime",
      "Resolve digest-pinned amd64 runtime base images",
      { candidate: "true", localBases: true, env },
    );
    expect(result.status).not.toBe(0);
    expect(output).toBe("");
    expect(dockerCalls).toBe("");
  });

  it.each(["openclaw", "hermes", "dcode"])("rejects a substituted %s receipt on GPU", (name) => {
    const { result, dockerCalls } = runBaseResolution(
      "managed-image-protected-runtime",
      "Resolve digest-pinned amd64 runtime base images",
      {
        candidate: "true",
        localBases: true,
        mutate(cache) {
          const receipt = path.join(cache, `${name}-base-receipt.json`);
          const original = JSON.parse(readFileSync(receipt, "utf8"));
          writeFileSync(receipt, JSON.stringify({ ...original, workflowSha: "d".repeat(40) }));
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("receipt does not match");
    expect(dockerCalls).toBe("");
  });

  it("accepts only the all-agent multiarch activation contract (#7744)", () => {
    const activation = {
      agents: PROTECTED_MANAGED_IMAGE_AGENTS,
      contractVersion: 1,
      jobId: PROTECTED_MANAGED_IMAGE_MULTIARCH_JOB_ID,
      platforms: PROTECTED_MANAGED_IMAGE_PLATFORMS,
    };

    expect(parseProtectedManagedImageActivation(activation)).toEqual(activation);
    expect(() =>
      parseProtectedManagedImageActivation({ ...activation, jobId: "untrusted-job" }),
    ).toThrow("activation contract is invalid");
  });

  it.each(PROTECTED_MANAGED_IMAGE_AGENTS)(
    "accepts an immutable isolated candidate base for %s",
    (agent) => {
      const localBase = `localhost:5000/nemoclaw-managed-protected-base/${agent}@sha256:${"d".repeat(64)}`;
      const valid = contracts("linux/amd64").map((entry) =>
        entry.agent === agent ? { ...entry, baseReference: localBase } : entry,
      );
      expect(parseProtectedManagedImageContracts(valid, "linux/amd64")).toEqual(valid);
    },
  );

  it.each(["openclaw", "hermes"])("rejects a candidate DCode base for %s", (agent) => {
    const localBase = `localhost:5000/nemoclaw-managed-protected-base/langchain-deepagents-code@sha256:${"d".repeat(64)}`;
    const wrongAgent = contracts("linux/amd64").map((entry) =>
      entry.agent === agent ? { ...entry, baseReference: localBase } : entry,
    );
    expect(() => parseProtectedManagedImageContracts(wrongAgent, "linux/amd64")).toThrow(
      /base reference/,
    );
  });

  it.each([
    `example.com/nemoclaw-managed-protected-base/langchain-deepagents-code@sha256:${"d".repeat(64)}`,
    "localhost:5000/nemoclaw-managed-protected-base/langchain-deepagents-code:latest",
  ])("rejects an untrusted or mutable candidate base %s", (invalid) => {
    const wrongReference = contracts("linux/amd64").map((entry) =>
      entry.agent === "langchain-deepagents-code" ? { ...entry, baseReference: invalid } : entry,
    );
    expect(() => parseProtectedManagedImageContracts(wrongReference, "linux/amd64")).toThrow(
      /base reference/,
    );
  });

  it("accepts candidate-base activation with the explicit version 2 contract", () => {
    const activation = {
      agents: PROTECTED_MANAGED_IMAGE_AGENTS,
      contractVersion: 2,
      dcodeBaseSource: "candidate",
      jobId: PROTECTED_MANAGED_IMAGE_MULTIARCH_JOB_ID,
      platforms: PROTECTED_MANAGED_IMAGE_PLATFORMS,
    };
    expect(parseProtectedManagedImageActivation(activation)).toEqual(activation);
  });

  it.each([
    { contractVersion: "2", dcodeBaseSource: "candidate" },
    { contractVersion: 1, dcodeBaseSource: "candidate" },
    { contractVersion: 2, dcodeBaseSource: "latest" },
    { contractVersion: 2, dcodeBaseSource: undefined },
  ])("rejects invalid candidate-base activation %j", (invalid) => {
    expect(() =>
      parseProtectedManagedImageActivation({
        agents: PROTECTED_MANAGED_IMAGE_AGENTS,
        jobId: PROTECTED_MANAGED_IMAGE_MULTIARCH_JOB_ID,
        platforms: PROTECTED_MANAGED_IMAGE_PLATFORMS,
        ...invalid,
      }),
    ).toThrow();
  });

  it("ships the exact activation contract consumed by the trusted lane (#7744)", () => {
    const activation = JSON.parse(
      readFileSync(PROTECTED_MANAGED_IMAGE_ACTIVATION_PATH, "utf8"),
    ) as unknown;

    expect(parseProtectedManagedImageActivation(activation)).toEqual({
      agents: PROTECTED_MANAGED_IMAGE_AGENTS,
      contractVersion: 2,
      dcodeBaseSource: "candidate",
      jobId: PROTECTED_MANAGED_IMAGE_MULTIARCH_JOB_ID,
      platforms: PROTECTED_MANAGED_IMAGE_PLATFORMS,
    });
  });

  it.each(PROTECTED_MANAGED_IMAGE_PLATFORMS)(
    "accepts one unique immutable image for every shipped agent on %s (#7744)",
    (platform) => {
      const value = contracts(platform);
      expect(parseProtectedManagedImageContracts(value, platform)).toEqual(value);
    },
  );

  it("rejects an incomplete or duplicated all-agent cohort (#7744)", () => {
    const value = contracts("linux/amd64");
    expect(() => parseProtectedManagedImageContracts(value.slice(0, 2), "linux/amd64")).toThrow(
      "exactly all shipped agents",
    );
    expect(() =>
      parseProtectedManagedImageContracts([value[0], value[0], value[2]], "linux/amd64"),
    ).toThrow("each shipped agent once");
  });

  it("rejects cross-platform or mutable image evidence (#7744)", () => {
    const value = contracts("linux/amd64");
    expect(() => parseProtectedManagedImageContracts(value, "linux/arm64")).toThrow(
      "wrong platform",
    );
    expect(() =>
      parseProtectedManagedImageContracts(
        [{ ...value[0], reference: value[0].reference.split("@")[0] }, value[1], value[2]],
        "linux/amd64",
      ),
    ).toThrow("exact agent digest");
  });

  it("rejects identity drift and unexpected receipt fields (#7744)", () => {
    const value = contracts("linux/arm64");
    expect(() =>
      parseProtectedManagedImageContracts(
        [{ ...value[0], digest: `sha256:${"f".repeat(64)}` }, value[1], value[2]],
        "linux/arm64",
      ),
    ).toThrow("exact agent digest");
    expect(() =>
      parseProtectedManagedImageContracts(
        [{ ...value[0], baseReference: value[1].baseReference }, value[1], value[2]],
        "linux/arm64",
      ),
    ).toThrow("invalid base reference");
    expect(() =>
      parseProtectedManagedImageContracts(
        [{ ...value[0], aliases: ["latest"] }, value[1], value[2]],
        "linux/arm64",
      ),
    ).toThrow("unexpected fields");
  });

  it.each(PROTECTED_MANAGED_IMAGE_PLATFORMS)(
    "binds exact protected build and direct-start evidence on %s (#7744)",
    (platform) => {
      const value = evidence(platform);
      expect(parseProtectedManagedImageEvidence(value, evidenceIdentity(platform))).toEqual(value);
    },
  );

  it("rejects stale identity and incomplete direct-start evidence (#7744)", () => {
    const value = evidence("linux/arm64");
    expect(() =>
      parseProtectedManagedImageEvidence(
        { ...value, headSha: "e".repeat(40) },
        evidenceIdentity("linux/arm64"),
      ),
    ).toThrow("evidence identity is invalid");
    expect(() =>
      parseProtectedManagedImageEvidence(
        { ...value, directRuns: value.directRuns.slice(0, 2) },
        evidenceIdentity("linux/arm64"),
      ),
    ).toThrow("directly run every contract");
    expect(() =>
      parseProtectedManagedImageEvidence(
        {
          ...value,
          directRuns: [value.directRuns[0], value.directRuns[0], value.directRuns[2]],
        },
        evidenceIdentity("linux/arm64"),
      ),
    ).toThrow("does not match its exact contract");
  });

  it.each(Array.from(CANDIDATE_MANAGED_IMAGE_AGENTS, (value) => [value]))(
    "keeps candidate agent %s outside the shipped managed-image inventory (#7927)",
    (agent) => {
      expect([...PROTECTED_MANAGED_IMAGE_AGENTS]).toEqual([...SHIPPED_MANAGED_IMAGE_AGENTS]);

      expect(PROTECTED_MANAGED_IMAGE_AGENTS).not.toContain(agent);
    },
  );
});
