// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cloneAndDeepFreeze } from "../../core/immutable";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../state/registry/types";
import { cloneSandboxWorkloadReceipt } from "../../state/registry/workload";
import type { ResolvedCorporateCa } from "../corporate-ca-types";
import {
  isManagedImageAgent,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  type ManagedImageAgent,
  type ManagedImageContractV1,
  parseManagedImageContractV1,
} from "../managed-image/contract";
import { validateManagedStartupCorporateCaTransport } from "../managed-startup/application";
import {
  decodeManagedStartupProfile,
  type ManagedStartupProfile,
} from "../managed-startup/profile";

export type ManagedWorkloadReceipt = Extract<
  SandboxWorkloadReceipt,
  { readonly kind: "managed-image" }
>;

export interface ManagedWorkloadAuthority {
  readonly agent: ManagedImageAgent;
  readonly receipt: ManagedWorkloadReceipt;
  readonly contract: ManagedImageContractV1;
  readonly profile: ManagedStartupProfile;
  readonly corporateCa: ResolvedCorporateCa | null;
}

export class ManagedWorkloadAuthorityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Invalid managed workload authority: ${message}`, options);
    this.name = "ManagedWorkloadAuthorityError";
  }
}

function isManagedImageReference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Object.values(MANAGED_IMAGE_REPOSITORIES).some((repository) =>
      value.startsWith(`${repository}@sha256:`),
    )
  );
}

function exactAgent(value: string | null | undefined): ManagedImageAgent {
  const normalized = value?.trim();
  if (!normalized) {
    throw new ManagedWorkloadAuthorityError(
      "the durable managed workload does not record an explicit agent",
    );
  }
  if (isManagedImageAgent(normalized)) return normalized;
  throw new ManagedWorkloadAuthorityError(`'${normalized}' is not a managed-image agent`);
}

function contractFromReceipt(
  receipt: ManagedWorkloadReceipt,
  agent: ManagedImageAgent,
): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const referencePrefix = `${image}@`;
  if (!receipt.reference.startsWith(referencePrefix)) {
    throw new ManagedWorkloadAuthorityError(
      `the recorded image reference does not belong to '${agent}'`,
    );
  }
  if (receipt.platform === undefined) {
    throw new ManagedWorkloadAuthorityError(
      "the durable managed workload does not record an explicit OCI platform",
    );
  }
  const digest = receipt.reference.slice(referencePrefix.length);
  try {
    return parseManagedImageContractV1(
      {
        contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
        agent,
        platform: receipt.platform,
        image,
        digest,
        reference: receipt.reference,
        source: {
          repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
          revision: receipt.sourceRevision,
          release: receipt.release,
          cohort: receipt.sourceCohort,
        },
        startupProfileContractVersion: receipt.startupProfileContractVersion,
        capabilityContractVersion: receipt.capabilityContractVersion,
      },
      agent,
    );
  } catch (error) {
    throw new ManagedWorkloadAuthorityError("the durable image contract failed validation", {
      cause: error,
    });
  }
}

function corporateCaFromReceipt(
  receipt: ManagedWorkloadReceipt,
  profile: ManagedStartupProfile,
): ResolvedCorporateCa | null {
  let bytes: Buffer | null;
  try {
    bytes = validateManagedStartupCorporateCaTransport(receipt.corporateCaB64, profile);
  } catch (error) {
    throw new ManagedWorkloadAuthorityError(
      "the corporate CA transport does not match the recorded startup profile",
      { cause: error },
    );
  }
  return bytes === null
    ? null
    : {
        pem: bytes.toString("utf8"),
        sourcePath: "managed-workload-authority",
        sourceEnv: "managed-workload-authority",
      };
}

/**
 * Read a durable managed workload without consulting a mutable release
 * pointer. The returned receipt is cloned and the contract, profile, and CA
 * transport are revalidated as one authority unit.
 *
 * A normal custom/legacy workload returns null. A row that looks managed but
 * cannot prove its exact immutable authority fails closed.
 */
export function readManagedWorkloadAuthority(
  entry: Pick<SandboxEntry, "agent" | "fromDockerfile" | "imageTag" | "workload">,
): ManagedWorkloadAuthority | null {
  const managedLooking =
    isManagedImageReference(entry.imageTag) || entry.workload?.kind === "managed-image";
  if (!managedLooking) return null;

  const cloned = cloneSandboxWorkloadReceipt(entry.workload);
  if (cloned?.kind !== "managed-image") {
    throw new ManagedWorkloadAuthorityError(
      "the managed image has no valid durable workload receipt",
    );
  }
  if (entry.imageTag !== cloned.reference) {
    throw new ManagedWorkloadAuthorityError(
      "the registry image reference does not match the durable workload receipt",
    );
  }
  if (entry.fromDockerfile) {
    throw new ManagedWorkloadAuthorityError(
      "a managed image receipt cannot be combined with a custom Dockerfile",
    );
  }

  const agent = exactAgent(entry.agent);
  const contract = contractFromReceipt(cloned, agent);
  let profile: ManagedStartupProfile;
  try {
    profile = decodeManagedStartupProfile(cloned.encodedProfile);
  } catch (error) {
    throw new ManagedWorkloadAuthorityError("the recorded startup profile is invalid", {
      cause: error,
    });
  }
  if (profile.agent !== agent) {
    throw new ManagedWorkloadAuthorityError(
      `the recorded startup profile belongs to '${profile.agent}', not '${agent}'`,
    );
  }

  return cloneAndDeepFreeze({
    agent,
    receipt: cloned,
    contract,
    profile,
    corporateCa: corporateCaFromReceipt(cloned, profile),
  });
}
