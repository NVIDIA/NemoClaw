// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

type Step = {
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Job = {
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  permissions?: string | Record<string, string>;
  "runs-on"?: string;
  steps?: Step[];
  strategy?: { matrix?: unknown };
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  concurrency?: { "cancel-in-progress"?: boolean | string; group?: string };
  jobs?: Record<string, Job>;
  on?: Record<
    string,
    {
      inputs?: Record<string, { default?: unknown; required?: boolean; type?: string }>;
      paths?: string[];
    }
  >;
  permissions?: string | Record<string, string>;
};

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const workflow = YAML.parse(
  fs.readFileSync(path.join(repoRoot, ".github", "workflows", "llama-cpp-image.yaml"), "utf8"),
) as Workflow;
const imageManifest = YAML.parse(
  fs.readFileSync(
    path.join(repoRoot, "managed-inference", "images", "llama-cpp", "image.yaml"),
    "utf8",
  ),
) as {
  spec?: {
    publication?: {
      qualification?: { probeBounds?: unknown; probes?: string[] } & Record<string, unknown>;
    };
  };
};
const attestationWorkflow = YAML.parse(
  fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "llama-cpp-image-attest.yaml"),
    "utf8",
  ),
) as Workflow;
const fullShaAction = /^[^@]+@[0-9a-f]{40}$/u;

function required<T>(value: T | undefined, message: string): T {
  return (
    value ??
    (() => {
      throw new Error(message);
    })()
  );
}

function namedStep(job: Job, name: string): Step {
  return required(
    job.steps?.find((candidate) => candidate.name === name),
    `llama.cpp image workflow is missing '${name}'`,
  );
}

function publicationQualificationFilter(step: Step): string {
  const source = required(step.run, "publication gate script is missing");
  const match = /if ! jq -e '\n(?<filter>[\s\S]*?)\n' <<< "\$QUALIFICATION"/u.exec(source);
  return required(match?.groups?.filter, "publication qualification jq filter is missing");
}

function runPublicationQualificationFilter(filter: string, value: unknown) {
  return spawnSync("jq", ["-e", filter], {
    encoding: "utf8",
    input: JSON.stringify(value),
  });
}

function permissionValues(value: string | Record<string, string> | undefined): string[] {
  return typeof value === "string" ? [value] : Object.values(value ?? {});
}

function jobPermissionValues(workflowValue: Workflow): string[] {
  return Object.values(workflowValue.jobs ?? {}).flatMap((job) =>
    permissionValues(job.permissions),
  );
}

function runAnonymousPull(step: Step, result: "denied" | "success") {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llama-cpp-anonymous-pull-"));
  const fakeBin = path.join(temporaryRoot, "bin");
  const invocationLog = path.join(temporaryRoot, "docker-invocations");
  const configLog = path.join(temporaryRoot, "docker-config");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$INVOCATION_LOG"
if [ "$1" = "pull" ]; then
  printf '%s\n' "$DOCKER_CONFIG" > "$CONFIG_LOG"
  [ -z "\${DOCKER_AUTH_CONFIG+x}" ] || exit 91
  if [ "$RESULT" = "denied" ]; then
    exit 37
  fi
  exit 0
elif [ "$*" = "image inspect --format {{.Id}} ghcr.io/nvidia/nemoclaw/llama-cpp-server@sha256:${"a".repeat(64)}" ]; then
  printf 'sha256:%s\n' '${"b".repeat(64)}'
elif [ "$*" = "image inspect --format {{.Id}} sha256:${"b".repeat(64)}" ]; then
  printf 'sha256:%s\n' '${"b".repeat(64)}'
else
  exit 92
fi
`,
    { mode: 0o755 },
  );

  try {
    const command = required(step.run, "anonymous pull script is missing");
    const commandResult = spawnSync("bash", ["--noprofile", "--norc", "-c", command], {
      encoding: "utf8",
      env: {
        ...process.env,
        ARCH: "arm64",
        CONFIG_LOG: configLog,
        DIGEST: `sha256:${"a".repeat(64)}`,
        DOCKER_AUTH_CONFIG: "must-not-reach-docker",
        IMAGE: "ghcr.io/nvidia/nemoclaw/llama-cpp-server",
        INVOCATION_LOG: invocationLog,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        PLATFORM: "linux/arm64",
        RESULT: result,
        RUNNER_TEMP: temporaryRoot,
      },
    });
    const anonymousConfig = fs.readFileSync(configLog, "utf8").trim();
    const evidencePath = path.join(
      temporaryRoot,
      "llama-cpp-anonymous-pulls",
      "anonymous-pull-arm64.json",
    );
    return {
      ...commandResult,
      anonymousConfigWasRemoved: !fs.existsSync(anonymousConfig),
      evidence: fs.existsSync(evidencePath)
        ? (JSON.parse(fs.readFileSync(evidencePath, "utf8")) as Record<string, unknown>)
        : null,
      invocations: fs.readFileSync(invocationLog, "utf8").trim().split("\n"),
    };
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

function candidateIndexFilter(step: Step): string {
  const source = required(step.run, "candidate assembly script is missing");
  const match =
    /--arg arm64 [^\n]+ '\n(?<filter>[\s\S]*?)\n\s+' "\$RUNNER_TEMP\/llama-cpp-candidate\/candidate-index\.json"/u.exec(
      source,
    );
  return required(match?.groups?.filter, "candidate index jq filter is missing");
}

function runCandidateIndexFilter(filter: string, candidate: unknown, amd64: string, arm64: string) {
  return spawnSync("jq", ["-e", "--arg", "amd64", amd64, "--arg", "arm64", arm64, filter], {
    encoding: "utf8",
    input: JSON.stringify(candidate),
  });
}

describe("llama.cpp image PR workflow", () => {
  const config = required(workflow.jobs?.config, "config job is missing");
  const build = required(workflow.jobs?.["pr-build"], "native PR build job is missing");
  const buildArgGuard = namedStep(build, "Validate native PR image build args");
  const buildStep = namedStep(build, "Build native PR image without publishing");
  const validate = namedStep(build, "Validate native PR image contract");

  it("keeps pull requests read-only while exposing only an explicit manual publication trigger (#8250)", () => {
    expect(workflow.on?.pull_request?.paths).toEqual(
      expect.arrayContaining([
        ".github/workflows/llama-cpp-image.yaml",
        ".github/workflows/llama-cpp-image-attest.yaml",
        "managed-inference/images/llama-cpp/**",
        "managed-inference/recipes/llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1.yaml",
        "scripts/checks/export-llama-cpp-image-config.mts",
        "scripts/checks/verify-llama-cpp-image-publication-evidence.sh",
        "test/inference/llama/llama-cpp-image-publication-evidence.test.ts",
      ]),
    );
    expect(Object.keys(workflow.on ?? {})).toEqual(["pull_request", "workflow_dispatch"]);
    expect(workflow.on?.workflow_dispatch?.inputs?.publish).toEqual({
      description: "Publish the declaratively enabled run-unique candidate from main",
      required: true,
      default: false,
      type: "boolean",
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(permissionValues(build.permissions)).not.toContain("write");
    expect(permissionValues(build.permissions)).not.toContain("write-all");
    const unsafeFixture = YAML.parse("jobs:\n  unsafe:\n    permissions: write-all\n") as Workflow;
    expect(jobPermissionValues(unsafeFixture)).toContain("write-all");
    expect(JSON.stringify(build)).not.toContain("docker/login-action");
    expect(buildStep.with?.push).toBe(false);
    expect(buildStep.with?.load).toBe(true);
    expect(workflow.concurrency).toEqual({
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
      group: "${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
    });
    expect(build.if).toBe("github.event_name == 'pull_request'");
  });

  it("passes declarative source, base image, runtime ID, and platform values to each image build (#8231)", () => {
    expect(config.outputs).toMatchObject({
      backend_directory: "${{ steps.manifest.outputs.backend_directory }}",
      compiler_c: "${{ steps.manifest.outputs.compiler_c }}",
      compiler_cuda_host_cxx: "${{ steps.manifest.outputs.compiler_cuda_host_cxx }}",
      compiler_cxx: "${{ steps.manifest.outputs.compiler_cxx }}",
      cuda_dev_image: "${{ steps.manifest.outputs.cuda_dev_image }}",
      cuda_runtime_image: "${{ steps.manifest.outputs.cuda_runtime_image }}",
      image: "${{ steps.manifest.outputs.image }}",
      matrix: "${{ steps.manifest.outputs.matrix }}",
      request_guard_go_version: "${{ steps.manifest.outputs.request_guard_go_version }}",
      runtime_forbidden_paths: "${{ steps.manifest.outputs.runtime_forbidden_paths }}",
      runtime_gid: "${{ steps.manifest.outputs.runtime_gid }}",
      runtime_required_paths: "${{ steps.manifest.outputs.runtime_required_paths }}",
      runtime_uid: "${{ steps.manifest.outputs.runtime_uid }}",
      source_archive_sha256: "${{ steps.manifest.outputs.source_archive_sha256 }}",
      source_revision: "${{ steps.manifest.outputs.source_revision }}",
    });
    expect(
      [
        "publication_allowed_ref",
        "publication_anonymous_exact_digest_pull",
        "publication_candidate_tag_template",
        "publication_enabled",
        "publication_platforms",
        "publication_provenance_predicate_type",
        "publication_qualification",
        "publication_receipt_retention_days",
        "publication_receipt_schema_version",
        "publication_repository",
        "publication_sbom_format",
        "publication_signature_identity",
        "publication_signature_issuer",
        "publication_signature_mode",
        "publication_signature_transparency_log",
        "publication_trigger",
        "publication_vulnerability_only_fixed",
        "publication_vulnerability_scanner",
        "publication_vulnerability_severity_cutoff",
      ].every((output) =>
        Object.is(config.outputs?.[output], `\${{ steps.manifest.outputs.${output} }}`),
      ),
    ).toBe(true);
    expect(namedStep(config, "Compile image manifest").run).toBe(
      "node --experimental-strip-types --no-warnings scripts/checks/export-llama-cpp-image-config.mts",
    );
    expect(build.needs).toBe("config");
    expect(build["runs-on"]).toBe("${{ matrix.runner }}");
    expect(build.strategy?.matrix).toBe("${{ fromJSON(needs.config.outputs.matrix) }}");

    const args = String(buildStep.with?.["build-args"] ?? "");
    expect(
      [
        "backend_directory",
        "compiler_c",
        "compiler_cuda_host_cxx",
        "compiler_cxx",
        "cuda_dev_image",
        "cuda_runtime_image",
        "request_guard_go_version",
        "runtime_gid",
        "runtime_uid",
        "source_archive_sha256",
        "source_revision",
      ].every((output) => args.includes(`needs.config.outputs.${output}`)),
    ).toBe(true);
    expect(args).toContain("CUDA_ARCHITECTURES=${{ matrix.cuda_architectures }}");
    expect(args).toContain(
      "REQUEST_GUARD_GO_ARCHIVE_SHA256=${{ matrix.request_guard_go_archive_sha256 }}",
    );
    expect(validate.run).toContain(
      'Labels["io.nvidia.nemoclaw.inference-server.request-guard.go.version"] == $requestGuardGoVersion',
    );
    expect(validate.run).toContain(
      'Labels["io.nvidia.nemoclaw.inference-server.request-guard.go.archive-sha256"] == $requestGuardGoArchive',
    );
    expect(args).toContain("TARGETPLATFORM=${{ matrix.platform }}");
    expect(args).not.toMatch(/sha256:[0-9a-f]{64}/u);
    expect(args).not.toMatch(/[0-9a-f]{40}/u);

    const buildArgNames = [...args.matchAll(/^([A-Z0-9_]+)=/gmu)].map((match) => match[1]);
    const guardedArgNames = [
      ...(buildArgGuard.run ?? "").matchAll(/--build-arg "([A-Z0-9_]+)=/gu),
    ].map((match) => match[1]);
    expect(guardedArgNames).toEqual(buildArgNames);
    expect(buildArgGuard.run).toContain("scripts/check-production-build-args.sh");
    expect(build.steps?.indexOf(buildArgGuard)).toBeLessThan(
      build.steps?.indexOf(buildStep) ?? Number.POSITIVE_INFINITY,
    );
  });

  it("gates digest-first native publication on an enabled main-only declarative contract (#8250)", () => {
    const gate = required(workflow.jobs?.["publication-gate"], "publication gate is missing");
    const publish = required(workflow.jobs?.["publish-platform"], "platform publisher is missing");
    const publishGuard = namedStep(publish, "Validate trusted image build args");
    const publishBuild = namedStep(publish, "Publish exact platform digest");
    const exportDigest = namedStep(publish, "Export validated platform digest");
    const logout = namedStep(publish, "Remove GHCR publication credentials");
    const anonymousPull = namedStep(publish, "Verify anonymous exact platform pull");
    const uploadAnonymousPull = namedStep(publish, "Upload anonymous pull evidence");
    const uploadDigest = namedStep(publish, "Upload platform digest");
    const assemble = required(
      workflow.jobs?.["assemble-candidate"],
      "candidate assembly job is missing",
    );
    const assembleStep = namedStep(assemble, "Assemble candidate index and capture exact digest");

    expect(gate.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(gate.if).toContain("inputs.publish == true");
    expect(gate.permissions).toEqual({});
    const gateStep = namedStep(gate, "Enforce declarative publication boundary");
    expect(gateStep.run).toContain('PUBLICATION_ENABLED" != "true"');
    expect(gateStep.run).toContain('GITHUB_REPOSITORY" != "NVIDIA/NemoClaw"');
    expect(gateStep.run).toContain('GITHUB_REF" != "$ALLOWED_REF"');
    expect(gateStep.run).toContain(
      `and .probes == ${JSON.stringify(
        required(
          imageManifest.spec?.publication?.qualification?.probes,
          "publication qualification probes are missing",
        ),
      )}`,
    );
    const qualification = required(
      imageManifest.spec?.publication?.qualification,
      "publication qualification is missing",
    );
    const filter = publicationQualificationFilter(gateStep);
    const valid = runPublicationQualificationFilter(filter, qualification);
    expect(valid.status, valid.stderr).toBe(0);

    const missingBounds = structuredClone(qualification);
    delete missingBounds.probeBounds;
    expect(runPublicationQualificationFilter(filter, missingBounds).status).not.toBe(0);

    const driftedBounds = structuredClone(qualification);
    driftedBounds.probeBounds = {
      ...(driftedBounds.probeBounds as Record<string, unknown>),
      clientTimeoutMilliseconds: 251,
    };
    expect(runPublicationQualificationFilter(filter, driftedBounds).status).not.toBe(0);
    expect(workflow.jobs?.["publication-preflight"]).toBeUndefined();
    expect(publish.needs).toEqual(["config", "publication-gate"]);
    expect(publish.permissions).toEqual({
      contents: "read",
      packages: "write",
    });
    expect(publish["runs-on"]).toBe("${{ matrix.runner }}");
    expect(publish.strategy?.matrix).toBe("${{ fromJSON(needs.config.outputs.matrix) }}");
    expect(publishBuild.with?.outputs).toBe(
      "type=image,name=${{ needs.config.outputs.publication_repository }},push-by-digest=true,name-canonical=true,push=true",
    );
    expect(publishBuild.with?.tags).toBeUndefined();
    expect(publishBuild.with?.provenance).toBe(false);
    expect(publishBuild.with?.sbom).toBe(false);
    const publishArgs = String(publishBuild.with?.["build-args"] ?? "");
    expect(publishArgs).toContain(
      "REQUEST_GUARD_GO_ARCHIVE_SHA256=${{ matrix.request_guard_go_archive_sha256 }}",
    );
    expect(publishArgs).toContain(
      "REQUEST_GUARD_GO_VERSION=${{ needs.config.outputs.request_guard_go_version }}",
    );
    const publishArgNames = [...publishArgs.matchAll(/^([A-Z0-9_]+)=/gmu)].map((match) => match[1]);
    const guardedArgNames = [
      ...(publishGuard.run ?? "").matchAll(/--build-arg "([A-Z0-9_]+)=/gu),
    ].map((match) => match[1]);
    expect(guardedArgNames).toEqual(publishArgNames);
    expect(publish.steps?.indexOf(publishGuard)).toBeLessThan(
      publish.steps?.indexOf(publishBuild) ?? Number.POSITIVE_INFINITY,
    );
    expect(logout.if).toBe("always()");
    expect(logout.run).toBe("docker logout ghcr.io");
    expect(publish.steps?.indexOf(publishBuild)).toBeLessThan(
      publish.steps?.indexOf(exportDigest) ?? Number.POSITIVE_INFINITY,
    );
    expect(publish.steps?.indexOf(exportDigest)).toBeLessThan(
      publish.steps?.indexOf(logout) ?? Number.POSITIVE_INFINITY,
    );
    expect(publish.steps?.indexOf(logout)).toBeLessThan(
      publish.steps?.indexOf(anonymousPull) ?? Number.POSITIVE_INFINITY,
    );
    expect(publish.steps?.indexOf(anonymousPull)).toBeLessThan(
      publish.steps?.indexOf(uploadAnonymousPull) ?? Number.POSITIVE_INFINITY,
    );
    expect(publish.steps?.indexOf(uploadAnonymousPull)).toBeLessThan(
      publish.steps?.indexOf(uploadDigest) ?? Number.POSITIVE_INFINITY,
    );
    expect(uploadAnonymousPull.with).toMatchObject({
      name: "llama-cpp-anonymous-pull-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.arch }}",
      path: "${{ runner.temp }}/llama-cpp-anonymous-pulls/anonymous-pull-${{ matrix.arch }}.json",
      "if-no-files-found": "error",
    });
    expect(assemble.needs).toEqual(["config", "publication-gate", "publish-platform"]);
    expect(assembleStep.run).toContain(
      'docker buildx imagetools create --tag "$IMAGE:$CANDIDATE_TAG" "${sources[@]}"',
    );
    expect(assembleStep.run).not.toContain("scripts/checks/validate-managed-base-index.sh");
    expect(assembleStep.run).toContain("candidate-index.json");
    expect(assembleStep.run).toContain("platform-digests.json");
    expect(assembleStep.run).not.toMatch(/latest|stable|release/iu);
  });

  it("accepts direct platform manifests and rejects descriptor drift (#8231)", () => {
    const assemble = required(
      workflow.jobs?.["assemble-candidate"],
      "candidate assembly job is missing",
    );
    const assembleStep = namedStep(assemble, "Assemble candidate index and capture exact digest");
    const descriptor = (architecture: string, digest: string) => ({
      digest,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      platform: { architecture, os: "linux" },
      size: 4096,
    });
    const amd64 = `sha256:${"a".repeat(64)}`;
    const arm64 = `sha256:${"b".repeat(64)}`;
    const filter = candidateIndexFilter(assembleStep);
    const candidate = (manifests: ReturnType<typeof descriptor>[]) => ({
      manifests,
      mediaType: "application/vnd.oci.image.index.v1+json",
      schemaVersion: 2,
    });

    const accepted = runCandidateIndexFilter(
      filter,
      candidate([descriptor("amd64", amd64), descriptor("arm64", arm64)]),
      amd64,
      arm64,
    );
    expect(accepted.status, accepted.stderr).toBe(0);

    const rejected = runCandidateIndexFilter(
      filter,
      candidate([descriptor("amd64", arm64), descriptor("arm64", amd64)]),
      amd64,
      arm64,
    );
    expect(rejected.status).toBe(1);
  });

  it("requires an anonymous exact-digest pull after publication and before candidate assembly (#8250)", () => {
    const publish = required(workflow.jobs?.["publish-platform"], "platform publisher is missing");
    const anonymousPull = namedStep(publish, "Verify anonymous exact platform pull");

    const accepted = runAnonymousPull(anonymousPull, "success");
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.invocations).toEqual([
      `pull --platform linux/arm64 ghcr.io/nvidia/nemoclaw/llama-cpp-server@sha256:${"a".repeat(64)}`,
      `image inspect --format {{.Id}} ghcr.io/nvidia/nemoclaw/llama-cpp-server@sha256:${"a".repeat(64)}`,
      `image inspect --format {{.Id}} sha256:${"b".repeat(64)}`,
    ]);
    expect(accepted.evidence).toEqual({
      imageId: `sha256:${"b".repeat(64)}`,
      platform: "linux/arm64",
      platformDigest: `sha256:${"a".repeat(64)}`,
      reference: `ghcr.io/nvidia/nemoclaw/llama-cpp-server@sha256:${"a".repeat(64)}`,
    });
    expect(accepted.anonymousConfigWasRemoved).toBe(true);

    const rejected = runAnonymousPull(anonymousPull, "denied");
    expect(rejected.status).toBe(1);
    expect(rejected.stdout + rejected.stderr).toContain(
      "The GHCR package ghcr.io/nvidia/nemoclaw/llama-cpp-server must be public before candidate assembly.",
    );
    expect(rejected.anonymousConfigWasRemoved).toBe(true);
  });

  it("scans, attests, verifies, and creates a receipt for the exact candidate without a consumer alias (#8250)", () => {
    const scan = required(workflow.jobs?.["scan-candidate"], "scan job is missing");
    const attest = required(workflow.jobs?.["attest-candidate"], "attestation job is missing");
    const verify = required(workflow.jobs?.["verify-candidate"], "verification job is missing");
    const scanStep = namedStep(scan, "Scan exact platform digest");
    const downloadSboms = namedStep(verify, "Download SPDX SBOMs");
    const crypto = namedStep(verify, "Verify cryptographic evidence");
    const receipt = namedStep(verify, "Verify publication evidence and create receipt");
    const downloadAnonymousPull = namedStep(verify, "Download anonymous pull evidence");

    expect(scan.needs).toEqual(["config", "publication-gate", "assemble-candidate"]);
    expect(scanStep.uses).toBe("anchore/scan-action@e1165082ffb1fe366ebaf02d8526e7c4989ea9d2");
    expect(scanStep.with).toMatchObject({
      "severity-cutoff": "${{ needs.config.outputs.publication_vulnerability_severity_cutoff }}",
      "only-fixed": "${{ needs.config.outputs.publication_vulnerability_only_fixed }}",
      "fail-build": true,
      "output-format": "json",
    });
    expect(attest.needs).toEqual([
      "config",
      "publication-gate",
      "assemble-candidate",
      "scan-candidate",
    ]);
    expect(attest.uses).toBe("./.github/workflows/llama-cpp-image-attest.yaml");
    expect(attest.permissions).toEqual({
      attestations: "write",
      contents: "read",
      "id-token": "write",
      packages: "write",
    });
    expect(verify.needs).toEqual([
      "config",
      "publication-gate",
      "assemble-candidate",
      "scan-candidate",
      "attest-candidate",
    ]);
    expect(crypto.run).toContain("cosign verify \\");
    expect(crypto.run).toContain("cosign verify-attestation \\");
    expect(crypto.run).toContain('--certificate-identity "$CERTIFICATE_IDENTITY"');
    expect(crypto.run).toContain('--certificate-oidc-issuer "$CERTIFICATE_OIDC_ISSUER"');
    expect(crypto.run).toContain("gh attestation verify");
    expect(crypto.run).toContain("--signer-workflow");
    expect(crypto.run).toContain('--source-ref "$EXPECTED_REF"');
    expect(crypto.run).toContain('--source-digest "$EXPECTED_REVISION"');
    expect(downloadSboms.with).toEqual({
      pattern: "llama-cpp-sbom-*-${{ needs.assemble-candidate.outputs.candidate_tag }}",
      path: "${{ runner.temp }}/llama-cpp-evidence",
      "merge-multiple": true,
    });
    expect(downloadAnonymousPull.with).toEqual({
      pattern: "llama-cpp-anonymous-pull-${{ github.run_id }}-${{ github.run_attempt }}-*",
      path: "${{ runner.temp }}/llama-cpp-evidence",
      "merge-multiple": true,
    });
    expect(receipt.run).toContain("scripts/checks/verify-llama-cpp-image-publication-evidence.sh");
    expect(receipt.run).toContain('--sbom-amd64 "$evidence/llama-cpp-sbom-amd64.spdx.json"');
    expect(receipt.run).toContain('--sbom-arm64 "$evidence/llama-cpp-sbom-arm64.spdx.json"');
    expect(receipt.run).toContain('--anonymous-pull-amd64 "$evidence/anonymous-pull-amd64.json"');
    expect(receipt.run).toContain('--anonymous-pull-arm64 "$evidence/anonymous-pull-arm64.json"');
    const publicationJobs = [
      "publish-platform",
      "assemble-candidate",
      "scan-candidate",
      "attest-candidate",
      "verify-candidate",
    ].map((name) => required(workflow.jobs?.[name], `${name} job is missing`));
    const shellTags = publicationJobs.flatMap((job) =>
      (job.steps ?? []).flatMap((step) =>
        [...(step.run ?? "").matchAll(/--tag\s+("[^"]+"|'[^']+'|\S+)/gu)].map((match) => match[1]),
      ),
    );
    const actionTags = publicationJobs.flatMap((job) =>
      (job.steps ?? []).flatMap((step) =>
        step.with?.tags === undefined ? [] : [String(step.with.tags)],
      ),
    );
    expect([...shellTags, ...actionTags]).toEqual(['"$IMAGE:$CANDIDATE_TAG"']);
  });

  it("uses an isolated reusable workflow for SPDX, SLSA, and keyless index signing (#8250)", () => {
    expect(attestationWorkflow.permissions).toEqual({});
    expect(attestationWorkflow.on?.workflow_call?.inputs).toEqual(
      expect.objectContaining({
        candidate_tag: expect.objectContaining({
          required: true,
          type: "string",
        }),
        digest: expect.objectContaining({ required: true, type: "string" }),
        image: expect.objectContaining({ required: true, type: "string" }),
        retention_days: expect.objectContaining({
          required: true,
          type: "number",
        }),
        sbom_format: expect.objectContaining({
          required: true,
          type: "string",
        }),
      }),
    );
    const validateInputs = required(
      attestationWorkflow.jobs?.["validate-inputs"],
      "reusable input validation is missing",
    );
    const attest = required(
      attestationWorkflow.jobs?.attest,
      "reusable attestation job is missing",
    );
    expect(validateInputs.permissions).toEqual({});
    const reusableGate = namedStep(validateInputs, "Validate exact inputs");
    expect(reusableGate.env?.CALLER_WORKFLOW_REF).toBe("${{ github.workflow_ref }}");
    expect(reusableGate.run).toContain('GITHUB_REPOSITORY" != "NVIDIA/NemoClaw"');
    expect(reusableGate.run).toContain('GITHUB_EVENT_NAME" != "workflow_dispatch"');
    expect(reusableGate.run).toContain('GITHUB_REF" != "refs/heads/main"');
    expect(reusableGate.run).toContain(
      'CALLER_WORKFLOW_REF" != "NVIDIA/NemoClaw/.github/workflows/llama-cpp-image.yaml@refs/heads/main"',
    );
    expect(attest.permissions).toEqual({
      attestations: "write",
      contents: "read",
      "id-token": "write",
      packages: "write",
    });
    const sbomSteps = (attest.steps ?? []).filter((step) =>
      step.uses?.startsWith("anchore/sbom-action@"),
    );
    expect(sbomSteps).toHaveLength(2);
    expect(sbomSteps.map((step) => step.uses)).toEqual([
      "anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610",
      "anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610",
    ]);
    expect(sbomSteps.map((step) => step.with?.["artifact-name"])).toEqual([
      "llama-cpp-sbom-amd64-${{ needs.validate-inputs.outputs.candidate_tag }}",
      "llama-cpp-sbom-arm64-${{ needs.validate-inputs.outputs.candidate_tag }}",
    ]);
    expect(sbomSteps.map((step) => step.with?.["output-file"])).toEqual([
      "llama-cpp-sbom-amd64.spdx.json",
      "llama-cpp-sbom-arm64.spdx.json",
    ]);
    expect(sbomSteps.map((step) => step.with?.["upload-artifact"])).toEqual([false, false]);
    const uploadAmd64Sbom = namedStep(attest, "Upload amd64 SPDX SBOM");
    const uploadArm64Sbom = namedStep(attest, "Upload arm64 SPDX SBOM");
    expect(uploadAmd64Sbom.uses).toBe(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(uploadAmd64Sbom.with).toEqual({
      name: "llama-cpp-sbom-amd64-${{ needs.validate-inputs.outputs.candidate_tag }}",
      path: "llama-cpp-sbom-amd64.spdx.json",
      "if-no-files-found": "error",
      "retention-days": "${{ needs.validate-inputs.outputs.retention_days }}",
    });
    expect(uploadArm64Sbom.uses).toBe(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(uploadArm64Sbom.with).toEqual({
      name: "llama-cpp-sbom-arm64-${{ needs.validate-inputs.outputs.candidate_tag }}",
      path: "llama-cpp-sbom-arm64.spdx.json",
      "if-no-files-found": "error",
      "retention-days": "${{ needs.validate-inputs.outputs.retention_days }}",
    });
    expect(namedStep(attest, "Attest SLSA build provenance").uses).toBe(
      "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8",
    );
    expect(namedStep(attest, "Sign exact candidate index").run).toContain(
      'cosign sign --yes "$IMAGE@$DIGEST"',
    );
    expect(JSON.stringify(attestationWorkflow)).not.toContain("secrets.");
    (attest.steps ?? [])
      .map((step) => step.uses)
      .filter((uses): uses is string => uses !== undefined)
      .forEach((action) => {
        expect(action).toMatch(fullShaAction);
      });
  });

  it("pins actions and validates the native non-root read-only image (#8231)", () => {
    const actions = Object.values(workflow.jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.uses)
      .filter((uses): uses is string => uses !== undefined);
    actions.forEach((action) => {
      expect(action).toMatch(fullShaAction);
    });

    expect(buildStep.with?.platforms).toBe("${{ matrix.platform }}");
    expect(buildStep.with?.provenance).toBe(false);
    expect(buildStep.with?.sbom).toBe(false);
    expect(buildStep.with?.["cache-from"]).toBe("type=gha,scope=llama-cpp-${{ matrix.arch }}");
    expect(buildStep.with?.["cache-to"]).toBe(
      "type=gha,mode=max,scope=llama-cpp-${{ matrix.arch }}",
    );
    expect(validate.run).toContain('.Config.User == ($uid + ":" + $gid)');
    expect(validate.run).toContain("io.nvidia.nemoclaw.inference-server.upstream.revision");
    expect(validate.run).toContain("--network none");
    expect(validate.run).toContain("--read-only");
    expect(validate.run).toContain("--tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777");
    expect(validate.run).toContain('grep -F "$SOURCE_REVISION"');
    expect(validate.run).toContain('docker export "$container_id"');
    expect(validate.run).toContain("RUNTIME_REQUIRED_PATHS");
    expect(validate.run).toContain("RUNTIME_FORBIDDEN_PATHS");
    expect(validate.run).not.toContain("--entrypoint /bin/sh");
  });
});
