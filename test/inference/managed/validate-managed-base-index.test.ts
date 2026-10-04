// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const validator = path.join(repoRoot, "scripts/checks/validate-managed-base-index.sh");
const image = "ghcr.io/nvidia/nemoclaw/base";
const amd64SourceDigest = `sha256:${"a".repeat(64)}`;
const arm64SourceDigest = `sha256:${"b".repeat(64)}`;
const indexDigest = `sha256:${"c".repeat(64)}`;
const amd64WorkloadDigest = `sha256:${"d".repeat(64)}`;
const arm64WorkloadDigest = `sha256:${"e".repeat(64)}`;
const amd64AttestationDigest = `sha256:${"f".repeat(64)}`;
const arm64AttestationDigest = `sha256:${"0".repeat(64)}`;
const foreignDigest = `sha256:${"9".repeat(64)}`;

type Descriptor = {
  annotations?: Record<string, string>;
  digest: string;
  mediaType: string;
  platform: { architecture: string; os: string };
  size: number;
};

function workloadDescriptor(architecture: string, digest: string): Descriptor {
  return {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest,
    size: 1234,
    platform: { architecture, os: "linux" },
  };
}

function attestationDescriptor(workloadDigest: string, digest: string): Descriptor {
  return {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest,
    size: 567,
    annotations: {
      "vnd.docker.reference.digest": workloadDigest,
      "vnd.docker.reference.type": "attestation-manifest",
    },
    platform: { architecture: "unknown", os: "unknown" },
  };
}

function index(manifests: Descriptor[]): string {
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests,
  });
}

const amd64Workload = workloadDescriptor("amd64", amd64WorkloadDigest);
const arm64Workload = workloadDescriptor("arm64", arm64WorkloadDigest);
const amd64Attestation = attestationDescriptor(amd64WorkloadDigest, amd64AttestationDigest);
const arm64Attestation = attestationDescriptor(arm64WorkloadDigest, arm64AttestationDigest);

type Fixture = {
  amd64Source?: string;
  amd64SourceDigestArgument?: string;
  arm64Source?: string;
  arm64SourceDigestArgument?: string;
  published?: string;
  reference?: string;
};

function runValidator(fixture: Fixture = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-base-index-"));
  const fakeBin = path.join(temporaryRoot, "bin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(temporaryRoot, "amd64-source.json"),
    fixture.amd64Source ?? index([amd64Workload, amd64Attestation]),
  );
  fs.writeFileSync(
    path.join(temporaryRoot, "arm64-source.json"),
    fixture.arm64Source ?? index([arm64Workload, arm64Attestation]),
  );
  fs.writeFileSync(
    path.join(temporaryRoot, "published.json"),
    fixture.published ?? index([amd64Workload, amd64Attestation, arm64Workload, arm64Attestation]),
  );
  fs.writeFileSync(
    path.join(fakeBin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
test "\${1:-} \${2:-} \${3:-} \${5:-}" = "buildx imagetools inspect --raw"
case "\${4:-}" in
  "$FINAL_REFERENCE") cat "$FIXTURE_ROOT/published.json" ;;
  "$AMD64_SOURCE_REFERENCE") cat "$FIXTURE_ROOT/amd64-source.json" ;;
  "$ARM64_SOURCE_REFERENCE") cat "$FIXTURE_ROOT/arm64-source.json" ;;
  *) exit 90 ;;
esac
`,
    { mode: 0o755 },
  );

  try {
    return spawnSync(
      validator,
      [
        fixture.reference ?? `${image}@${indexDigest}`,
        fixture.amd64SourceDigestArgument ?? amd64SourceDigest,
        fixture.arm64SourceDigestArgument ?? arm64SourceDigest,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          FIXTURE_ROOT: temporaryRoot,
          FINAL_REFERENCE: `${image}@${indexDigest}`,
          AMD64_SOURCE_REFERENCE: `${image}@${amd64SourceDigest}`,
          ARM64_SOURCE_REFERENCE: `${image}@${arm64SourceDigest}`,
        },
      },
    );
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

describe("managed base index validation", () => {
  it("resolves runnable descriptors from provenance-wrapped platform indexes (#7744)", () => {
    const accepted = runValidator();

    expect(accepted.status, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toEqual({
      "linux/amd64": amd64WorkloadDigest,
      "linux/arm64": arm64WorkloadDigest,
    });
  });

  it("rejects a mutable managed base reference (#7744)", () => {
    const mutable = runValidator({ reference: `${image}:latest` });

    expect(mutable.status).not.toBe(0);
    expect(mutable.stderr).toContain("managed base index reference must be immutable");
  });

  it("rejects a malformed platform source digest argument (#7744)", () => {
    const malformed = runValidator({ amd64SourceDigestArgument: "sha256:not-a-digest" });

    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain("managed base platform source digest is invalid");
  });

  it("rejects platform source digest arguments assigned to the wrong architecture (#7744)", () => {
    const swapped = runValidator({
      amd64SourceDigestArgument: arm64SourceDigest,
      arm64SourceDigestArgument: amd64SourceDigest,
    });

    expect(swapped.status).not.toBe(0);
    expect(swapped.stderr).toContain(
      "source index must contain exactly one linux/amd64 descriptor",
    );
  });

  it("rejects a retagged index whose workload descriptor is stale (#7744)", () => {
    const retagged = runValidator({
      published: index([
        workloadDescriptor("amd64", foreignDigest),
        amd64Attestation,
        arm64Workload,
        arm64Attestation,
      ]),
    });

    expect(retagged.status).not.toBe(0);
    expect(retagged.stderr).toContain(
      "linux/amd64 descriptor does not match this run's resolved workload descriptor",
    );
  });

  it("rejects a stale source index whose workload differs from publication (#7744)", () => {
    const staleSource = runValidator({
      amd64Source: index([
        workloadDescriptor("amd64", foreignDigest),
        attestationDescriptor(foreignDigest, amd64AttestationDigest),
      ]),
    });

    expect(staleSource.status).not.toBe(0);
    expect(staleSource.stderr).toContain(
      "linux/amd64 descriptor does not match this run's resolved workload descriptor",
    );
  });

  it("rejects an ambiguous source index with duplicate workload descriptors (#7744)", () => {
    const ambiguousSource = runValidator({
      amd64Source: index([
        amd64Workload,
        workloadDescriptor("amd64", foreignDigest),
        amd64Attestation,
      ]),
    });

    expect(ambiguousSource.status).not.toBe(0);
    expect(ambiguousSource.stderr).toContain(
      "source index must contain exactly one linux/amd64 descriptor",
    );
  });

  it("rejects a final index that drops this run's provenance descriptor (#7744)", () => {
    const missingProvenance = runValidator({
      published: index([amd64Workload, arm64Workload, arm64Attestation]),
    });

    expect(missingProvenance.status).not.toBe(0);
    expect(missingProvenance.stderr).toContain(
      "index descriptors do not match this run's platform source indexes",
    );
  });

  it("rejects a source index whose provenance is bound to another workload (#7744)", () => {
    const mismatchedProvenance = runValidator({
      amd64Source: index([
        amd64Workload,
        attestationDescriptor(arm64WorkloadDigest, amd64AttestationDigest),
      ]),
    });

    expect(mismatchedProvenance.status).not.toBe(0);
    expect(mismatchedProvenance.stderr).toContain(
      "source index for linux/amd64 is not one workload plus its provenance manifest",
    );
  });
});
