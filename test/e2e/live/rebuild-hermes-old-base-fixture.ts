// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const REBUILD_HERMES_OLD_BASE_FIXTURE = {
  imageRef:
    "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:7e9378c50f291e6dd80b922e8b89e0e7edf21e4e3a80b8c2664be01976f59aa8",
  release: "v0.0.80",
  revision: "c5f1194b7bc94d02bb99097b894133a285de4d7a",
  source: "https://github.com/NVIDIA/NemoClaw",
  // v0.0.80 is the first immutable release with the target's v0.18 state
  // schema. This performance lane owns stale base selection and state
  // preservation; upstream cross-version state migration is a separate
  // product boundary.
  hermesSemver: "0.18.0",
  hermesCalver: "2026.7.1",
} as const;

export interface RebuildHermesOldBaseFixtureEvidence {
  imageRef: string;
  release: string;
  revision: string;
  source: string;
  hermesVersion: string;
}

/**
 * Fail closed unless phase 2 pulled the exact reviewed historical image and
 * its published provenance still identifies the Hermes version under test.
 */
export function verifyRebuildHermesOldBaseFixture(
  imageRef: string,
  labelsJson: string,
  versionOutput: string,
): RebuildHermesOldBaseFixtureEvidence {
  const expected = REBUILD_HERMES_OLD_BASE_FIXTURE;
  if (imageRef !== expected.imageRef) {
    throw new Error("old Hermes fixture must use the reviewed immutable image digest");
  }

  let labels: Record<string, unknown>;
  try {
    const parsed = JSON.parse(labelsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    labels = parsed as Record<string, unknown>;
  } catch {
    throw new Error("old Hermes fixture OCI labels were not valid JSON");
  }

  const expectedLabels = {
    "org.opencontainers.image.version": expected.release,
    "org.opencontainers.image.revision": expected.revision,
    "org.opencontainers.image.source": expected.source,
  } as const;
  for (const [name, value] of Object.entries(expectedLabels)) {
    if (labels[name] !== value) {
      throw new Error(`old Hermes fixture OCI label '${name}' did not match '${value}'`);
    }
  }

  const expectedVersion = `Hermes Agent v${expected.hermesSemver} (${expected.hermesCalver})`;
  if (!versionOutput.includes(expectedVersion)) {
    throw new Error(`old Hermes fixture runtime did not report '${expectedVersion}'`);
  }

  return {
    imageRef,
    release: expected.release,
    revision: expected.revision,
    source: expected.source,
    hermesVersion: expectedVersion,
  };
}
