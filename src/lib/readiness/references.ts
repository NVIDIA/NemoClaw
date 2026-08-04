// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SystemReadinessReport } from "./types.js";

type ReadinessEntity = { id: string };

function addDuplicateIdErrors(
  collectionName: string,
  entities: readonly ReadinessEntity[],
  errors: string[],
): Set<string> {
  const ids = new Set<string>();

  for (const entity of entities) {
    if (ids.has(entity.id)) {
      errors.push(`${collectionName} contains duplicate ID ${entity.id}`);
    }
    ids.add(entity.id);
  }

  return ids;
}

function addMissingReferenceErrors(
  path: string,
  referenceIds: readonly string[] | undefined,
  targetIds: ReadonlySet<string>,
  errors: string[],
): void {
  for (const referenceId of referenceIds ?? []) {
    if (!targetIds.has(referenceId)) {
      errors.push(`${path} references unknown ID ${referenceId}`);
    }
  }
}

export function getSystemReadinessReferenceErrors(
  report: SystemReadinessReport,
): readonly string[] {
  const errors: string[] = [];
  addDuplicateIdErrors("observations", report.observations, errors);
  const capabilityIds = addDuplicateIdErrors("capabilities", report.capabilities, errors);
  addDuplicateIdErrors("qualifications", report.qualifications, errors);
  addDuplicateIdErrors("findings", report.findings, errors);
  const evidenceIds = addDuplicateIdErrors("evidence", report.evidence, errors);

  for (const [index, observation] of report.observations.entries()) {
    addMissingReferenceErrors(
      `observations[${index}].evidenceIds`,
      observation.evidenceIds,
      evidenceIds,
      errors,
    );
  }

  for (const [index, capability] of report.capabilities.entries()) {
    addMissingReferenceErrors(
      `capabilities[${index}].evidenceIds`,
      capability.evidenceIds,
      evidenceIds,
      errors,
    );
  }

  for (const [index, qualification] of report.qualifications.entries()) {
    addMissingReferenceErrors(
      `qualifications[${index}].capabilityIds`,
      qualification.capabilityIds,
      capabilityIds,
      errors,
    );
  }

  for (const [index, finding] of report.findings.entries()) {
    addMissingReferenceErrors(
      `findings[${index}].capabilityIds`,
      finding.capabilityIds,
      capabilityIds,
      errors,
    );
    addMissingReferenceErrors(
      `findings[${index}].evidenceIds`,
      finding.evidenceIds,
      evidenceIds,
      errors,
    );
  }

  return errors;
}
