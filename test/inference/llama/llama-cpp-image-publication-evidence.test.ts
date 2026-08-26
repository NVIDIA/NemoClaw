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
  "verify-llama-cpp-image-publication-evidence.sh",
);
const image = "ghcr.io/nvidia/nemoclaw/llama-cpp-server";
const amd64Digest = `sha256:${"a".repeat(64)}`;
const arm64Digest = `sha256:${"b".repeat(64)}`;
const revision = "c".repeat(40);
const sourceRevision = "d".repeat(40);
const sourceArchiveSha256 = `sha256:${"e".repeat(64)}`;
const cudaDevelopmentBase = `docker.io/nvidia/cuda@sha256:${"1".repeat(64)}`;
const cudaRuntimeBase = `docker.io/nvidia/cuda@sha256:${"2".repeat(64)}`;
const runId = "30935138368";
const runAttempt = "1";
const certificateIdentity =
  "https://github.com/NVIDIA/NemoClaw/.github/workflows/llama-cpp-image-attest.yaml@refs/heads/main";
const certificateOidcIssuer = "https://token.actions.githubusercontent.com";
const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

type FixtureOptions = {
  anonymousEvidenceMismatch?: "amd64" | "arm64";
  anonymousMismatch?: boolean;
  duplicateSbom?: boolean;
  identicalSbomDocuments?: boolean;
  indexArm64Digest?: string;
  provenanceDigest?: string;
  provenanceTimestamps?: unknown[];
  repository?: string;
  sbomDigest?: string;
  sbomStatementTypes?: { amd64?: string; arm64?: string };
  scanHigh?: "amd64" | "arm64";
  signatureDigest?: string;
  signatureReference?: string;
  signatureType?: string;
};

function spdx(namespace: string) {
  return {
    SPDXID: "SPDXRef-DOCUMENT",
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    documentNamespace: `https://example.test/spdx/${namespace}`,
    creationInfo: { creators: ["Tool: fixture"] },
    packages: [],
  };
}

function runEvidence(options: FixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-llama-publication-"));
  const bin = path.join(root, "bin");
  const evidence = path.join(root, "evidence");
  const receiptPath = path.join(evidence, "receipt.json");
  fs.mkdirSync(bin);
  fs.mkdirSync(evidence);

  const candidate = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: amd64Digest,
        size: 101,
        platform: { os: "linux", architecture: "amd64" },
      },
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: options.indexArm64Digest ?? arm64Digest,
        size: 102,
        platform: { os: "linux", architecture: "arm64" },
      },
    ],
  });
  const candidateDigest = sha256(candidate);
  const reference = `${image}@${candidateDigest}`;
  const anonymousPull = (arch: "amd64" | "arm64", digest: string, imageId: string) => ({
    imageId,
    platform: `linux/${arch}`,
    platformDigest:
      options.anonymousEvidenceMismatch === arch ? `sha256:${"0".repeat(64)}` : digest,
    reference: `${image}@${digest}`,
  });
  const amd64Sbom = spdx("amd64");
  const arm64Sbom = options.identicalSbomDocuments ? amd64Sbom : spdx("arm64");
  const sbomStatement = (predicate: ReturnType<typeof spdx>, statementType?: string) => ({
    _type: statementType ?? "https://in-toto.io/Statement/v0.1",
    predicateType: "https://spdx.dev/Document",
    subject: [
      {
        name: image,
        digest: {
          sha256: options.sbomDigest ?? candidateDigest.slice("sha256:".length),
        },
      },
    ],
    predicate,
  });
  const sbomVerification = [
    {
      payload: Buffer.from(
        JSON.stringify(sbomStatement(amd64Sbom, options.sbomStatementTypes?.amd64)),
      ).toString("base64"),
    },
    {
      payload: Buffer.from(
        JSON.stringify(
          sbomStatement(
            options.duplicateSbom ? amd64Sbom : arm64Sbom,
            options.sbomStatementTypes?.arm64,
          ),
        ),
      ).toString("base64"),
    },
  ];
  const provenanceVerification = [
    {
      attestation: { bundle: "fixture" },
      verificationResult: {
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [
            {
              name: image,
              digest: {
                sha256: options.provenanceDigest ?? candidateDigest.slice("sha256:".length),
              },
            },
          ],
          predicate: {},
        },
        signature: {
          certificate: { subjectAlternativeName: certificateIdentity },
        },
        verifiedTimestamps: options.provenanceTimestamps ?? [{ type: "transparency-log" }],
      },
    },
  ];
  const signatureVerification = [
    {
      critical: {
        identity: { "docker-reference": reference },
        image: {
          "docker-manifest-digest": candidateDigest,
        },
        type: "https://spdx.dev/Document",
      },
      optional: {},
    },
    {
      critical: {
        identity: { "docker-reference": options.signatureReference ?? reference },
        image: {
          "docker-manifest-digest": options.signatureDigest ?? candidateDigest,
        },
        type: options.signatureType ?? "https://sigstore.dev/cosign/sign/v1",
      },
      optional: {},
    },
  ];
  const scan = (arch: "amd64" | "arm64", digest: string) => ({
    matches:
      options.scanHigh === arch
        ? [
            {
              vulnerability: {
                id: "CVE-2099-0001",
                severity: "High",
                fix: { versions: ["2.0.0"] },
              },
            },
          ]
        : [],
    source: { type: "image", target: { userInput: `${image}@${digest}` } },
    descriptor: { name: "grype", version: "0.99.0" },
  });

  const files = {
    "candidate-index.json": candidate,
    "anonymous-index.json": options.anonymousMismatch ? `${candidate}\n` : candidate,
    "platform-digests.json": JSON.stringify({
      "linux/amd64": amd64Digest,
      "linux/arm64": arm64Digest,
    }),
    "anonymous-pull-amd64.json": JSON.stringify(
      anonymousPull("amd64", amd64Digest, `sha256:${"3".repeat(64)}`),
    ),
    "anonymous-pull-arm64.json": JSON.stringify(
      anonymousPull("arm64", arm64Digest, `sha256:${"4".repeat(64)}`),
    ),
    "sbom-amd64.json": JSON.stringify(amd64Sbom),
    "sbom-arm64.json": JSON.stringify(arm64Sbom),
    "sbom-verification.json": JSON.stringify(sbomVerification),
    "provenance-verification.json": JSON.stringify(provenanceVerification),
    "signature-verification.json": JSON.stringify(signatureVerification),
    "scan-amd64.json": JSON.stringify(scan("amd64", amd64Digest)),
    "scan-arm64.json": JSON.stringify(scan("arm64", arm64Digest)),
  };
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(evidence, name), contents);
  }
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FIXTURE_ROOT/docker-invocations"
if [ "$*" = "buildx imagetools inspect ${reference} --raw" ]; then
  cp "$FIXTURE_ROOT/evidence/anonymous-index.json" /dev/stdout
else
  printf 'unexpected docker invocation: %s\n' "$*" >&2
  exit 90
fi
`,
    { mode: 0o755 },
  );
  const sharedDaemonReference = path.join(root, "pre-existing-daemon-reference");
  fs.writeFileSync(sharedDaemonReference, "owned-by-another-process\n");

  const result = spawnSync(
    "bash",
    [
      verifier,
      "--reference",
      reference,
      "--candidate-index",
      path.join(evidence, "candidate-index.json"),
      "--platform-digests",
      path.join(evidence, "platform-digests.json"),
      "--anonymous-pull-amd64",
      path.join(evidence, "anonymous-pull-amd64.json"),
      "--anonymous-pull-arm64",
      path.join(evidence, "anonymous-pull-arm64.json"),
      "--sbom-amd64",
      path.join(evidence, "sbom-amd64.json"),
      "--sbom-arm64",
      path.join(evidence, "sbom-arm64.json"),
      "--sbom-verification",
      path.join(evidence, "sbom-verification.json"),
      "--provenance-verification",
      path.join(evidence, "provenance-verification.json"),
      "--signature-verification",
      path.join(evidence, "signature-verification.json"),
      "--scan-amd64",
      path.join(evidence, "scan-amd64.json"),
      "--scan-arm64",
      path.join(evidence, "scan-arm64.json"),
      "--repository",
      options.repository ?? "NVIDIA/NemoClaw",
      "--revision",
      revision,
      "--source-revision",
      sourceRevision,
      "--source-archive-sha256",
      sourceArchiveSha256,
      "--cuda-development-base",
      cudaDevelopmentBase,
      "--cuda-runtime-base",
      cudaRuntimeBase,
      "--run-id",
      runId,
      "--run-attempt",
      runAttempt,
      "--certificate-identity",
      certificateIdentity,
      "--certificate-oidc-issuer",
      certificateOidcIssuer,
      "--output",
      receiptPath,
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
  const receipt = fs.existsSync(receiptPath)
    ? (JSON.parse(fs.readFileSync(receiptPath, "utf8")) as Record<string, unknown>)
    : null;
  const dockerInvocationPath = path.join(root, "docker-invocations");
  const dockerInvocations = fs.existsSync(dockerInvocationPath)
    ? fs.readFileSync(dockerInvocationPath, "utf8").trim()
    : "";
  const sharedDaemonReferenceWasPreserved =
    fs.readFileSync(sharedDaemonReference, "utf8") === "owned-by-another-process\n";
  fs.rmSync(root, { recursive: true, force: true });
  return {
    candidateDigest,
    dockerInvocations,
    receipt,
    result,
    sharedDaemonReferenceWasPreserved,
  };
}

describe("llama.cpp image publication evidence verifier", () => {
  it("binds isolated anonymous pulls without touching shared Docker image state (#8250)", () => {
    const fixture = runEvidence();

    expect(fixture.result.status, fixture.result.stderr).toBe(0);
    expect(fixture.dockerInvocations).toBe(
      `buildx imagetools inspect ${image}@${fixture.candidateDigest} --raw`,
    );
    expect(fixture.sharedDaemonReferenceWasPreserved).toBe(true);
    expect(fixture.receipt).toMatchObject({
      schemaVersion: 1,
      image: {
        repository: image,
        candidateTag: `llama-cpp-candidate-${runId}-${runAttempt}`,
        index: { digest: fixture.candidateDigest },
        platforms: { "linux/amd64": amd64Digest, "linux/arm64": arm64Digest },
      },
      build: {
        repository: "NVIDIA/NemoClaw",
        revision,
        source: {
          revision: sourceRevision,
          archiveSha256: sourceArchiveSha256,
        },
        cuda: {
          developmentBase: cudaDevelopmentBase,
          runtimeBase: cudaRuntimeBase,
        },
      },
      evidence: {
        sbom: { format: "spdx-json" },
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
        signature: {
          mode: "sigstore-keyless",
          certificateIdentity,
          certificateOidcIssuer,
          transparencyLog: "verified",
        },
        vulnerability: {
          scanner: "grype",
          severityCutoff: "high",
          onlyFixed: true,
        },
        anonymousPull: {
          exactDigest: true,
          platforms: [
            { platform: "linux/amd64", imageId: `sha256:${"3".repeat(64)}` },
            { platform: "linux/arm64", imageId: `sha256:${"4".repeat(64)}` },
          ],
        },
      },
    });
  });

  it.each([
    ["substituted platform descriptor", { indexArm64Digest: `sha256:${"f".repeat(64)}` }],
    ["anonymous bytes mismatch", { anonymousMismatch: true }],
    ["anonymous arm64 pull evidence mismatch", { anonymousEvidenceMismatch: "arm64" as const }],
    ["duplicate SBOM predicate", { duplicateSbom: true }],
    ["identical platform SBOM documents", { identicalSbomDocuments: true }],
    ["SBOM subject mismatch", { sbomDigest: "0".repeat(64) }],
    [
      "one SBOM statement type mismatch",
      { sbomStatementTypes: { arm64: "https://in-toto.io/Statement/v1" } },
    ],
    ["provenance subject mismatch", { provenanceDigest: "0".repeat(64) }],
    ["missing provenance transparency evidence", { provenanceTimestamps: [] }],
    ["signature subject mismatch", { signatureDigest: `sha256:${"0".repeat(64)}` }],
    ["signature reference mismatch", { signatureReference: image }],
    ["signature type mismatch", { signatureType: "cosign container image signature" }],
    ["source repository mismatch", { repository: "attacker/repository" }],
    ["high-severity vulnerability with an available fix", { scanHigh: "arm64" as const }],
  ])("rejects %s", (_name, options) => {
    const fixture = runEvidence(options);
    expect(fixture.result.status).not.toBe(0);
    expect(fixture.receipt).toBeNull();
  });
});
