// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const verifier = path.join(
  repoRoot,
  "scripts",
  "checks",
  "verify-managed-image-publication-evidence.sh",
);
const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const agent = "openclaw";
const platform = "linux/amd64";
const repository = "NVIDIA/NemoClaw";
const revision = "a".repeat(40);
const runId = "30863521971";
const runAttempt = "1";
const cohort = `ghrun-${runId}-${runAttempt}`;
const baseReference = `ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:${"5".repeat(64)}`;
const image = "ghcr.io/nvidia/nemoclaw/openclaw-sandbox";
const buildkitBaseDependencyUri = (targetPlatform: string) => {
  const [repositoryName, digest] = baseReference.split("@sha256:");
  return `pkg:docker/${repositoryName}?digest=sha256:${digest}&platform=${targetPlatform.replaceAll("/", "%2F")}`;
};

type FixtureOptions = {
  attestationArtifactType?: string;
  attestationConfigData?: string;
  attestationConfigDigest?: string;
  attestationSubjectDigest?: string;
  attestationSubjectSize?: number;
  attestationWorkloadDigest?: string;
  corruptSlsaBlob?: boolean;
  duplicateSlsaLayer?: boolean;
  omitSlsa?: boolean;
  omitSpdx?: boolean;
  slsaAgent?: string;
  slsaBaseReference?: string;
  slsaBuilderId?: string;
  slsaDependencyUri?: string;
  slsaCohort?: string;
  slsaLayerPredicateType?: string;
  slsaPlatform?: string;
  slsaStatementPredicateType?: string;
  slsaRevision?: string;
  slsaSource?: string;
  slsaSubjectDigest?: string;
  spdxSubjectDigest?: string;
};

function runEvidence(options: FixtureOptions = {}, digestOverride?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-image-evidence-"));
  const bin = path.join(root, "bin");
  const output = path.join(root, "evidence", "contract.json");

  const workload = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: `sha256:${"6".repeat(64)}`,
      size: 137,
    },
    layers: [],
  });
  const workloadDigest = sha256(workload);
  const workloadSha256 = workloadDigest.slice("sha256:".length);

  const actualAgent = options.slsaAgent ?? agent;
  const actualBaseReference = options.slsaBaseReference ?? baseReference;
  const actualCohort = options.slsaCohort ?? cohort;
  const actualPlatform = options.slsaPlatform ?? platform;
  const actualRevision = options.slsaRevision ?? revision;
  const actualSource = options.slsaSource ?? `https://github.com/${repository}`;
  const requestArgs = {
    "build-arg:BASE_IMAGE": actualBaseReference,
    "label:io.nvidia.nemoclaw.agent": actualAgent,
    "label:io.nvidia.nemoclaw.managed-image.cohort": actualCohort,
    "label:io.nvidia.nemoclaw.managed-image.contract": "1",
    "label:io.nvidia.nemoclaw.managed-image.platform": actualPlatform,
    "label:org.opencontainers.image.revision": actualRevision,
    "label:org.opencontainers.image.source": actualSource,
  };
  const slsa = JSON.stringify({
    _type: "https://in-toto.io/Statement/v1",
    predicateType: options.slsaStatementPredicateType ?? "https://slsa.dev/provenance/v1",
    subject: [
      {
        name: "pkg:docker/ghcr.io/nvidia/nemoclaw/openclaw-sandbox@latest?platform=linux%2Famd64",
        digest: {
          sha256: options.slsaSubjectDigest ?? workloadSha256,
        },
      },
    ],
    predicate: {
      buildDefinition: {
        buildType:
          "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
        externalParameters: {
          configSource: { path: "Dockerfile" },
          request: {
            frontend: "dockerfile.v0",
            args: requestArgs,
            locals: [{ name: "context" }, { name: "dockerfile" }],
            root: {
              configSource: { path: "Dockerfile" },
              request: {
                args: {
                  ...requestArgs,
                  "vcs:revision": actualRevision,
                  "vcs:source": actualSource,
                },
              },
            },
          },
        },
        internalParameters: { buildConfig: {} },
        resolvedDependencies: [
          {
            uri: options.slsaDependencyUri ?? buildkitBaseDependencyUri(platform),
            digest: { sha256: baseReference.split("@sha256:")[1] },
          },
        ],
      },
      runDetails: {
        builder: {
          id:
            options.slsaBuilderId ??
            `https://github.com/${repository}/actions/runs/${runId}/attempts/${runAttempt}`,
          version: { buildkit: "v0.23.2" },
        },
        metadata: { invocationId: "fixture" },
      },
    },
  });
  const spdx = JSON.stringify({
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://spdx.dev/Document",
    subject: [
      {
        name: "pkg:docker/ghcr.io/nvidia/nemoclaw/openclaw-sandbox@latest?platform=linux%2Famd64",
        digest: {
          sha256: options.spdxSubjectDigest ?? workloadSha256,
        },
      },
    ],
    predicate: {
      SPDXID: "SPDXRef-DOCUMENT",
      spdxVersion: "SPDX-2.3",
      dataLicense: "CC0-1.0",
      documentNamespace: "https://example.test/spdx/fixture",
      creationInfo: { creators: ["Tool: fixture"] },
      packages: [],
    },
  });
  const slsaDescriptor = {
    mediaType: "application/vnd.in-toto+json",
    digest: sha256(slsa),
    size: Buffer.byteLength(slsa),
    annotations: {
      "in-toto.io/predicate-type":
        options.slsaLayerPredicateType ?? "https://slsa.dev/provenance/v1",
    },
  };
  const spdxDescriptor = {
    mediaType: "application/vnd.in-toto+json",
    digest: sha256(spdx),
    size: Buffer.byteLength(spdx),
    annotations: { "in-toto.io/predicate-type": "https://spdx.dev/Document" },
  };
  const layers = options.duplicateSlsaLayer
    ? [slsaDescriptor, slsaDescriptor]
    : options.omitSlsa
      ? [spdxDescriptor]
      : options.omitSpdx
        ? [slsaDescriptor]
        : [slsaDescriptor, spdxDescriptor];
  const attestation = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType:
      options.attestationArtifactType ?? "application/vnd.docker.attestation.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.empty.v1+json",
      digest:
        options.attestationConfigDigest ??
        "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      size: 2,
      data: options.attestationConfigData ?? "e30=",
    },
    layers,
    subject: {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: options.attestationSubjectDigest ?? workloadDigest,
      size: options.attestationSubjectSize ?? Buffer.byteLength(workload),
    },
  });
  const attestationDigest = sha256(attestation);
  const candidate = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: workloadDigest,
        size: Buffer.byteLength(workload),
        platform: { os: "linux", architecture: "amd64" },
      },
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: attestationDigest,
        size: Buffer.byteLength(attestation),
        annotations: {
          "vnd.docker.reference.digest": options.attestationWorkloadDigest ?? workloadDigest,
          "vnd.docker.reference.type": "attestation-manifest",
        },
        platform: { os: "unknown", architecture: "unknown" },
      },
    ],
  });
  const candidateDigest = sha256(candidate);
  const reference = `${image}@${digestOverride ?? candidateDigest}`;
  const workloadReference = `${image}@${workloadDigest}`;
  const attestationReference = `${image}@${attestationDigest}`;

  fs.mkdirSync(bin);
  for (const [name, value] of [
    ["candidate.raw", candidate],
    ["workload.raw", workload],
    ["attestation.raw", attestation],
    ["slsa.json", options.corruptSlsaBlob ? `${slsa} ` : slsa],
    ["spdx.json", spdx],
  ] as const) {
    fs.writeFileSync(path.join(root, name), value);
  }
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"${attestationReference} --raw"* ]]; then
  cat "$FIXTURE_ROOT/attestation.raw"
elif [[ "$*" == *"${workloadReference} --raw"* ]]; then
  cat "$FIXTURE_ROOT/workload.raw"
elif [[ "$*" == *"${reference} --raw"* ]]; then
  cat "$FIXTURE_ROOT/candidate.raw"
else
  printf 'unexpected docker invocation: %s\n' "$*" >&2
  exit 90
fi
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
url=""
output=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    -H|--header|--retry) shift 2 ;;
    --fail|--silent|--show-error|--location) shift ;;
    https://*) url="$1"; shift ;;
    *) printf 'unexpected curl argument: %s\n' "$1" >&2; exit 91 ;;
  esac
done
case "$url" in
  *'/token?'*) printf '{"token":"fixture-token"}\n' ;;
  *'/blobs/${slsaDescriptor.digest}') cp "$FIXTURE_ROOT/slsa.json" "$output" ;;
  *'/blobs/${spdxDescriptor.digest}') cp "$FIXTURE_ROOT/spdx.json" "$output" ;;
  *) printf 'unexpected curl URL: %s\n' "$url" >&2; exit 92 ;;
esac
`,
    { mode: 0o755 },
  );

  const result = spawnSync(
    "bash",
    [
      verifier,
      "--reference",
      reference,
      "--digest",
      digestOverride ?? candidateDigest,
      "--platform",
      platform,
      "--agent",
      agent,
      "--base-reference",
      baseReference,
      "--repository",
      repository,
      "--revision",
      revision,
      "--cohort",
      cohort,
      "--run-id",
      runId,
      "--run-attempt",
      runAttempt,
      "--output",
      output,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FIXTURE_ROOT: root,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: root,
      },
    },
  );
  const evidence = fs.existsSync(output)
    ? (JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>)
    : null;
  fs.rmSync(root, { recursive: true, force: true });
  return {
    candidateDigest,
    evidence,
    result,
    slsaDescriptor,
    spdxDescriptor,
    workloadDigest,
  };
}

describe("managed image publication evidence verifier", () => {
  it("binds exact OCI descriptors to full SLSA v1 and SPDX statements", () => {
    const fixture = runEvidence();

    expect(fixture.result.status, fixture.result.stderr).toBe(0);
    expect(fixture.evidence).toMatchObject({
      candidateDescriptor: {
        mediaType: "application/vnd.oci.image.index.v1+json",
        digest: fixture.candidateDigest,
      },
      workloadDescriptor: {
        digest: fixture.workloadDigest,
        platform: { os: "linux", architecture: "amd64" },
      },
      attestations: {
        manifestDescriptor: {
          annotations: {
            "vnd.docker.reference.digest": fixture.workloadDigest,
            "vnd.docker.reference.type": "attestation-manifest",
          },
        },
        slsa: {
          descriptor: fixture.slsaDescriptor,
          statement: {
            type: "https://in-toto.io/Statement/v1",
            predicateType: "https://slsa.dev/provenance/v1",
            subject: { digest: fixture.workloadDigest },
            builderId: `https://github.com/${repository}/actions/runs/${runId}/attempts/${runAttempt}`,
            bindings: {
              agent,
              baseReference,
              cohort,
              platform,
              revision,
              source: `https://github.com/${repository}`,
            },
          },
        },
        spdx: {
          descriptor: fixture.spdxDescriptor,
          statement: {
            type: "https://in-toto.io/Statement/v1",
            predicateType: "https://spdx.dev/Document",
            subject: { digest: fixture.workloadDigest },
          },
        },
      },
    });
  });

  it.each(["curl", "docker"])(
    "rejects a non-GHCR reference before invoking registry tools [%s] (#7744)",
    (tool) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-image-evidence-identity-"));
      const bin = path.join(root, "bin");
      const toolTrace = path.join(root, "external-tool.trace");
      const digest = `sha256:${"7".repeat(64)}`;

      fs.mkdirSync(bin);

      fs.writeFileSync(
        path.join(bin, tool),
        '#!/bin/sh\nprintf \'%s\\n\' "$0" >> "$TOOL_TRACE"\nexit 99\n',
        { mode: 0o755 },
      );

      try {
        const result = spawnSync(
          "bash",
          [
            verifier,
            "--reference",
            `registry.example/nvidia/nemoclaw/openclaw-sandbox@${digest}`,
            "--digest",
            digest,
            "--platform",
            platform,
            "--agent",
            agent,
            "--base-reference",
            baseReference,
            "--repository",
            repository,
            "--revision",
            revision,
            "--cohort",
            cohort,
            "--run-id",
            runId,
            "--run-attempt",
            runAttempt,
            "--output",
            path.join(root, "evidence.json"),
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH ?? ""}`,
              TOOL_TRACE: toolTrace,
            },
          },
        );

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("managed image evidence identity is invalid");
        expect(fs.existsSync(toolTrace)).toBe(false);
      } finally {
        fs.rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("rejects candidate bytes that do not match the build digest", () => {
    const fixture = runEvidence({}, `sha256:${"f".repeat(64)}`);

    expect(fixture.result.status).not.toBe(0);
    expect(fixture.result.stderr).toContain("candidate index bytes do not match");
    expect(fixture.evidence).toBeNull();
  });

  it("rejects an attestation manifest linked to a different workload", () => {
    const fixture = runEvidence({
      attestationWorkloadDigest: `sha256:${"9".repeat(64)}`,
    });

    expect(fixture.result.status).not.toBe(0);
    expect(fixture.result.stderr).toContain("not bound to the workload");
    expect(fixture.evidence).toBeNull();
  });

  it.each([
    [
      "artifact type",
      { attestationArtifactType: "application/vnd.example.attestation.manifest.v1+json" },
    ],
    ["subject digest", { attestationSubjectDigest: `sha256:${"8".repeat(64)}` }],
    ["subject size", { attestationSubjectSize: 1 }],
    ["inline empty config", { attestationConfigData: "e31=" }],
    ["inline empty config digest", { attestationConfigDigest: `sha256:${"4".repeat(64)}` }],
  ])("rejects an attestation artifact with a different %s", (_label, options) => {
    const fixture = runEvidence(options);

    expect(fixture.result.status).not.toBe(0);
    expect(fixture.result.stderr).toContain(
      "attestation manifest is not the canonical workload-bound OCI artifact",
    );
    expect(fixture.evidence).toBeNull();
  });

  it.each([{ omitSlsa: true }, { omitSpdx: true }, { duplicateSlsaLayer: true }])(
    "rejects missing or duplicate predicate layers [case %#]",
    (options) => {
      const fixture = runEvidence(options);
      expect(fixture.result.status).not.toBe(0);
      expect(fixture.evidence).toBeNull();
    },
  );

  it("rejects an attestation layer labeled with the wrong predicate type", () => {
    const fixture = runEvidence({
      slsaLayerPredicateType: "https://slsa.dev/provenance/v0.2",
    });

    expect(fixture.result.status).not.toBe(0);
    expect(fixture.evidence).toBeNull();
  });

  it("rejects a statement blob whose bytes differ from its OCI descriptor", () => {
    const fixture = runEvidence({ corruptSlsaBlob: true });

    expect(fixture.result.status).not.toBe(0);
    expect(fixture.result.stderr).toContain("SLSA statement blob does not match");
    expect(fixture.evidence).toBeNull();
  });

  it.each([{ slsaSubjectDigest: "9".repeat(64) }, { spdxSubjectDigest: "9".repeat(64) }])(
    "rejects exact statement blobs mixed with a different workload subject [case %#]",
    (options) => {
      const fixture = runEvidence(options);
      expect(fixture.result.status).not.toBe(0);
      expect(fixture.result.stderr).toMatch(/statement does not bind/);
      expect(fixture.evidence).toBeNull();
    },
  );

  it.each([
    ["agent", { slsaAgent: "hermes" }],
    ["base image", { slsaBaseReference: `ghcr.io/example/base@sha256:${"7".repeat(64)}` }],
    [
      "base dependency platform",
      {
        slsaDependencyUri: buildkitBaseDependencyUri("linux/arm64"),
      },
    ],
    [
      "builder run id",
      {
        slsaBuilderId: `https://github.com/${repository}/actions/runs/1/attempts/${runAttempt}`,
      },
    ],
    [
      "builder run attempt",
      {
        slsaBuilderId: `https://github.com/${repository}/actions/runs/${runId}/attempts/2`,
      },
    ],
    ["cohort", { slsaCohort: "ghrun-1-2" }],
    [
      "statement predicate type",
      { slsaStatementPredicateType: "https://slsa.dev/provenance/v0.2" },
    ],
    ["platform", { slsaPlatform: "linux/arm64" }],
    ["repository", { slsaSource: "https://github.com/example/fork" }],
    ["revision", { slsaRevision: "b".repeat(40) }],
  ])("rejects SLSA v1 evidence for a different %s", (_label, options) => {
    const fixture = runEvidence(options);

    expect(fixture.result.status).not.toBe(0);
    expect(fixture.result.stderr).toContain("SLSA v1 statement does not bind");
    expect(fixture.evidence).toBeNull();
  });
});
