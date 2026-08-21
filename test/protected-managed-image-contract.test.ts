// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  CANDIDATE_MANAGED_IMAGE_AGENTS,
  SHIPPED_MANAGED_IMAGE_AGENTS,
} from "../src/lib/onboard/managed-image/contract.ts";
import {
  PROTECTED_MANAGED_IMAGE_ACTIVATION_PATH,
  PROTECTED_MANAGED_IMAGE_AGENTS,
  PROTECTED_MANAGED_IMAGE_MULTIARCH_JOB_ID,
  PROTECTED_MANAGED_IMAGE_PLATFORMS,
  type ProtectedManagedImagePlatform,
  parseProtectedManagedImageActivation,
  parseProtectedManagedImageContracts,
  parseProtectedManagedImageEvidence,
} from "../scripts/checks/protected-managed-image-contract.ts";

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
const ROOT = path.resolve(import.meta.dirname, "..");
const REVIEWED_HERMES_INDEX = `ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:${"9".repeat(64)}`;
const PLATFORM_DIGESTS = {
  openclaw: `sha256:${"1".repeat(64)}`,
  hermes: `sha256:${"2".repeat(64)}`,
  dcode: `sha256:${"3".repeat(64)}`,
} as const;
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

function runBaseResolution(jobId: string, stepName: string) {
  const fixture = mkdtempSync(path.join(tmpdir(), "nemoclaw-protected-bases-"));
  const fakeBin = path.join(fixture, "bin");
  const outputPath = path.join(fixture, "github-output");
  const runnerTemp = path.join(fixture, "runner-temp");
  mkdirSync(path.join(fixture, "agents", "hermes"), { recursive: true });
  mkdirSync(fakeBin);
  mkdirSync(runnerTemp);
  writeFileSync(outputPath, "");
  writeFileSync(
    path.join(fixture, "agents", "hermes", "Dockerfile"),
    `ARG BASE_IMAGE=${REVIEWED_HERMES_INDEX}\n`,
  );
  const dockerPath = path.join(fakeBin, "docker");
  writeFileSync(
    dockerPath,
    `#!/bin/sh
set -eu
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
    const result = spawnSync("bash", ["-c", workflowStep(jobId, stepName)], {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        PLATFORM: "linux/amd64",
        RUNNER_TEMP: runnerTemp,
      },
    });
    return {
      result,
      output: readFileSync(outputPath, "utf8"),
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
    ["managed-image-multiarch-startup", "Resolve exact platform base images"],
    ["managed-image-protected-runtime", "Resolve exact amd64 runtime base images"],
  ])("%s keeps non-Hermes base resolution separate", (jobId, stepName) => {
    const { result, output } = runBaseResolution(jobId, stepName);
    expect(result.status, result.stderr).toBe(0);
    expect(Object.fromEntries(output.trim().split("\n").map((line) => line.split("=")))).toEqual(
      {
        dcode: `ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base@${PLATFORM_DIGESTS.dcode}`,
        openclaw: `ghcr.io/nvidia/nemoclaw/sandbox-base@${PLATFORM_DIGESTS.openclaw}`,
      },
    );
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

  it("ships the exact activation contract consumed by the trusted lane (#7744)", () => {
    const activation = JSON.parse(
      readFileSync(PROTECTED_MANAGED_IMAGE_ACTIVATION_PATH, "utf8"),
    ) as unknown;

    expect(parseProtectedManagedImageActivation(activation)).toEqual({
      agents: PROTECTED_MANAGED_IMAGE_AGENTS,
      contractVersion: 1,
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
