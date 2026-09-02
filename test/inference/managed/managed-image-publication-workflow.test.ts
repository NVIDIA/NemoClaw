// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  publicationAgents,
  publicationPlatforms,
  reuseOpenclawAmd64FromAttemptOne,
  runManagedImagePromotion,
  runPublicationBarrier,
} from "../../helpers/managed-image-publication-barrier";
import {
  managedPromoter,
  readWorkflow,
  required,
  step,
} from "../../helpers/managed-image-publication-workflow";

describe("complete managed-image publication workflow", () => {
  it("pins a single native-platform PR base descriptor and fails closed on torn index evidence", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const builder = required(
      workflow.jobs?.["pr-build-and-entrypoint"],
      "managed-image workflow is missing its all-agent PR build and runtime gate",
    );
    const resolver = required(
      step(builder, "Resolve digest-pinned PR base for the native platform").run,
      "PR base resolver script is missing",
    );
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-base-"));
    const fakeBin = path.join(temporaryRoot, "bin");
    const aliasRaw = path.join(temporaryRoot, "alias.raw");
    const exactRaw = path.join(temporaryRoot, "exact.raw");
    const arm64ExactRaw = path.join(temporaryRoot, "arm64-exact.raw");
    const output = path.join(temporaryRoot, "output");
    const summary = path.join(temporaryRoot, "summary");
    fs.mkdirSync(fakeBin);
    const exactBody = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: `sha256:${"a".repeat(64)}`, size: 1 },
      layers: [],
    });
    const digest = `sha256:${createHash("sha256").update(exactBody).digest("hex")}`;
    const arm64ExactBody = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: `sha256:${"b".repeat(64)}`, size: 1 },
      layers: [],
    });
    const arm64Digest = `sha256:${createHash("sha256").update(arm64ExactBody).digest("hex")}`;
    const descriptor = {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest,
      size: exactBody.length,
      platform: { os: "linux", architecture: "amd64" },
    };
    const arm64Descriptor = {
      ...descriptor,
      digest: arm64Digest,
      size: arm64ExactBody.length,
      platform: { os: "linux", architecture: "arm64" },
    };
    const writeAlias = (manifests: unknown[]) => {
      fs.writeFileSync(
        aliasRaw,
        JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.index.v1+json",
          manifests,
        }),
      );
    };
    writeAlias([descriptor, arm64Descriptor]);
    fs.writeFileSync(exactRaw, exactBody);
    fs.writeFileSync(arm64ExactRaw, arm64ExactBody);
    fs.writeFileSync(
      path.join(fakeBin, "docker"),
      `#!/bin/bash
set -euo pipefail
if [ "\${1:-} \${2:-} \${3:-}" != "buildx imagetools inspect" ]; then
  exit 90
fi
if [[ "\${4:-}" == *":latest" ]]; then
  cat "$ALIAS_RAW"
elif [[ "\${4:-}" == *"@$ARM64_DIGEST" ]]; then
  cat "$ARM64_EXACT_RAW"
else
  cat "$EXACT_RAW"
fi
`,
      { mode: 0o755 },
    );
    const runResolver = (platform = "linux/amd64") =>
      spawnSync("bash", ["-c", resolver], {
        encoding: "utf8",
        env: {
          ...process.env,
          AGENT: "openclaw",
          ALIAS_RAW: aliasRaw,
          ARM64_DIGEST: arm64Digest,
          ARM64_EXACT_RAW: arm64ExactRaw,
          BASE_ALIAS: "ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
          BASE_DOCKERFILE: "Dockerfile.base",
          BASE_REPOSITORY: "ghcr.io/nvidia/nemoclaw/sandbox-base",
          BASE_SHA: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
          CANDIDATE_SHA: spawnSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
          }).stdout.trim(),
          DISPLAY_NAME: "OpenClaw",
          EXACT_RAW: exactRaw,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          LOCAL_BASE_REFERENCE: "nemoclaw-managed-pr/openclaw-base:test",
          PLATFORM: platform,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: temporaryRoot,
        },
      });

    try {
      const accepted = runResolver();
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(fs.readFileSync(output, "utf8")).toContain(
        `ref=ghcr.io/nvidia/nemoclaw/sandbox-base@${digest}`,
      );

      const acceptedArm64 = runResolver("linux/arm64");
      expect(acceptedArm64.status, acceptedArm64.stderr).toBe(0);
      expect(fs.readFileSync(output, "utf8")).toContain(
        `ref=ghcr.io/nvidia/nemoclaw/sandbox-base@${arm64Digest}`,
      );

      writeAlias([descriptor, descriptor, arm64Descriptor]);
      const duplicate = runResolver();
      expect(duplicate.status).not.toBe(0);
      expect(duplicate.stderr).toContain("does not contain exactly one linux/amd64 image");

      writeAlias([descriptor, arm64Descriptor]);
      fs.appendFileSync(exactRaw, " ");
      const wrongBody = runResolver();
      expect(wrongBody.status).not.toBe(0);
      expect(wrongBody.stderr).toContain(
        "exact PR base bytes do not match the selected descriptor digest",
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fails the barrier before alias code when either architecture is absent (#7744)", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) => candidates.slice(0, -1),
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected exactly six managed image candidate artifacts");
    expect(result.dockerCalls).toEqual([]);
  });

  it("fails the barrier before alias code on a duplicated architecture (#7744)", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) =>
        candidates.map((candidate) =>
          candidate.artifact === "managed-image-candidate-7744-openclaw-linux-arm64"
            ? {
                ...candidate,
                contract: { ...candidate.contract, platform: "linux/amd64" },
              }
            : candidate,
        ),
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("candidate artifact identity is invalid");
    expect(result.dockerCalls).toEqual([]);
  });

  it("fails the barrier before alias code on a mixed-run cohort (#7744)", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) =>
        candidates.map((candidate, index) =>
          index === 0
            ? {
                ...candidate,
                contract: {
                  ...candidate.contract,
                  source: {
                    ...(candidate.contract.source as Record<string, unknown>),
                    revision: "b".repeat(40),
                  },
                },
              }
            : candidate,
        ),
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "complete managed image candidate set failed closed validation",
    );
    expect(result.dockerCalls).toEqual([]);
  });

  it("fails closed before alias code when a candidate omits real SPDX evidence", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) => {
        const candidate = candidates[0]!;
        const contract = structuredClone(candidate.contract);
        const evidence = contract.publicationEvidence as Record<string, unknown>;
        const attestations = evidence.attestations as Record<string, unknown>;
        delete attestations.spdx;
        return [{ ...candidate, contract }, ...candidates.slice(1)];
      },
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "complete managed image candidate set failed closed validation",
    );
    expect(result.dockerCalls).toEqual([]);
  });

  it("fails closed before alias code on mixed workload and attestation descriptors", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(
      promoter,
      "Stage validated multi-platform managed image cohort and contracts",
    );
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) => {
        const candidate = candidates[0]!;
        const contract = structuredClone(candidate.contract);
        const evidence = contract.publicationEvidence as Record<string, unknown>;
        const attestations = evidence.attestations as Record<string, unknown>;
        const manifest = attestations.manifestDescriptor as Record<string, unknown>;
        const annotations = manifest.annotations as Record<string, unknown>;
        annotations["vnd.docker.reference.digest"] = `sha256:${"f".repeat(64)}`;
        return [{ ...candidate, contract }, ...candidates.slice(1)];
      },
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "complete managed image candidate set failed closed validation",
    );
    expect(result.dockerCalls).toEqual([]);
  });

  it("accepts one exact candidate for every agent and architecture (#7744)", () => {
    const barrier = step(
      managedPromoter(readWorkflow("managed-images.yaml")),
      "Validate complete managed image candidate set",
    );

    expect(runPublicationBarrier(barrier.run ?? "").status).toBe(0);
    const mixedAttempts = runPublicationBarrier(
      barrier.run ?? "",
      reuseOpenclawAmd64FromAttemptOne,
      "",
      {
        publicationCohort: "ghrun-7744-1",
      },
    );
    expect(mixedAttempts.status, mixedAttempts.stderr).toBe(0);
    const futureCohort = runPublicationBarrier(barrier.run ?? "", (value) => value, "", {
      publicationCohort: "ghrun-7744-3",
    });
    expect(futureCohort.status).not.toBe(0);
    expect(futureCohort.stderr).toContain("publication cohort is invalid");
    expect(futureCohort.dockerCalls).toEqual([]);
    const wrongRunCohort = runPublicationBarrier(barrier.run ?? "", (value) => value, "", {
      publicationCohort: "ghrun-8877-1",
    });
    expect(wrongRunCohort.status).not.toBe(0);
    expect(wrongRunCohort.stderr).toContain("publication cohort is invalid");
    expect(wrongRunCohort.dockerCalls).toEqual([]);
  });

  it.each([0, 3])("rejects producer attempt %s without publishing aliases", (producerAttempt) => {
    const barrier = step(
      managedPromoter(readWorkflow("managed-images.yaml")),
      "Validate complete managed image candidate set",
    );
    const invalidAttempt = runPublicationBarrier(barrier.run ?? "", (candidates) => {
      const candidate = candidates[0]!;
      return [
        {
          ...candidate,
          contract: {
            ...candidate.contract,
            run: { id: 7744, attempt: producerAttempt },
          },
        },
        ...candidates.slice(1),
      ];
    });

    expect(invalidAttempt.status).not.toBe(0);
    expect(invalidAttempt.stderr).toContain("candidate producer attempt is invalid");
    expect(invalidAttempt.dockerCalls).toEqual([]);
  });

  it("stages all multi-platform cohort aliases before moving the sole root pointer (#7744)", () => {
    const promotion = required(
      step(
        managedPromoter(readWorkflow("managed-images.yaml")),
        "Stage validated multi-platform managed image cohort and contracts",
      ).run,
      "managed image promotion script is missing",
    );
    const pointer = required(
      step(
        managedPromoter(readWorkflow("managed-images.yaml")),
        "Promote durable managed image cohort pointers",
      ).run,
      "managed image pointer script is missing",
    );
    const cohort = "ghrun-7744-2";
    const revision = "a".repeat(40);

    const failed = runManagedImagePromotion(promotion, "langchain-deepagents-code");
    const failedCalls = failed.calls.join("\n");
    expect(failed.status, failed.stderr).toBe(91);
    expect(failedCalls).toContain(`hermes-sandbox:cohort-${cohort}`);
    expect(failedCalls).toContain(`langchain-deepagents-code-sandbox:cohort-${cohort}`);
    expect(failedCalls).toContain(`openclaw-sandbox:cohort-${cohort}`);
    expect(failedCalls).not.toContain(`openclaw-sandbox:${revision}`);

    const accepted = runManagedImagePromotion(promotion, "", pointer);
    const acceptedCalls = accepted.calls.join("\n");
    expect(accepted.status, accepted.stderr).toBe(0);
    const cohortAgents = (accepted.cohortContract?.agents ?? {}) as Record<
      string,
      { reference?: string }
    >;
    const expectedPullCalls = publicationAgents.flatMap((agent) => {
      const reference = cohortAgents[agent]?.reference;
      expect(reference).toMatch(/^ghcr\.io\/nvidia\/nemoclaw\/.+@sha256:[0-9a-f]{64}$/u);
      return publicationPlatforms.map((platform) => `pull --platform ${platform} ${reference}`);
    });
    const lastCohortStage = Math.max(
      acceptedCalls.indexOf(`hermes-sandbox:cohort-${cohort}`),
      acceptedCalls.indexOf(`langchain-deepagents-code-sandbox:cohort-${cohort}`),
      acceptedCalls.indexOf(`openclaw-sandbox:cohort-${cohort}`),
    );
    const rootPointer = acceptedCalls.indexOf(`openclaw-sandbox:${revision}`);

    expect(accepted.calls.filter((call) => call.startsWith("pull ")).sort()).toEqual(
      expectedPullCalls.sort(),
    );
    expectedPullCalls.forEach((pull) => {
      const index = accepted.calls.indexOf(pull);
      const reference = pull.match(/^pull --platform linux\/(?:amd64|arm64) (.+)$/u)?.[1];
      expect(reference).toBeDefined();
      expect(index).toBeGreaterThanOrEqual(0);
      expect(accepted.calls[index + 1]).toBe(`image rm ${reference}`);
    });
    expect(lastCohortStage).toBeGreaterThanOrEqual(0);
    expect(rootPointer).toBeGreaterThan(lastCohortStage);
    expect(acceptedCalls).not.toContain(`hermes-sandbox:${revision}`);
    expect(acceptedCalls).not.toContain(`langchain-deepagents-code-sandbox:${revision}`);
    expect(Object.keys(accepted.platformContracts).sort()).toEqual(
      publicationAgents
        .flatMap((agent) => publicationPlatforms.map((platform) => `${agent}|${platform}`))
        .sort(),
    );
    expect(accepted.cohortContract).toMatchObject({
      contractVersion: 2,
      cohort,
      platforms: ["linux/amd64", "linux/arm64"],
      agents: {
        openclaw: expect.objectContaining({
          descriptor: expect.objectContaining({
            mediaType: "application/vnd.oci.image.index.v1+json",
            digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          }),
          platforms: expect.objectContaining({
            "linux/amd64": expect.objectContaining({
              publicationEvidence: expect.objectContaining({
                workloadDescriptor: expect.any(Object),
                attestations: expect.any(Object),
              }),
            }),
            "linux/arm64": expect.any(Object),
          }),
        }),
        hermes: expect.any(Object),
        "langchain-deepagents-code": expect.any(Object),
      },
    });

    const reusedKey = "openclaw|linux/amd64";
    const mixedPromotion = runManagedImagePromotion(promotion, "", "", {
      mutate: reuseOpenclawAmd64FromAttemptOne,
      publicationCohort: "ghrun-7744-1",
    });
    expect(mixedPromotion.status, mixedPromotion.stderr).toBe(0);
    expect(mixedPromotion.platformContracts[reusedKey]?.run).toEqual({ id: 7744, attempt: 1 });
  });
});
