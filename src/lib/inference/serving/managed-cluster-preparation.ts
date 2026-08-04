// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
  NO_PREPARATION_REF,
  SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
} from "./adapter-registry.js";

const MODEL_ID = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const MODEL_REVISION = /^[0-9a-f]{40,64}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAX_PATH_BYTES = 4_096;
const MAX_REPLACEMENT_BYTES = 64 * 1_024;

export type ManagedClusterVllmPreparationRecipe =
  | { readonly ref: typeof NO_PREPARATION_REF }
  | {
      readonly ref: typeof SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF;
      readonly snapshotCopy: {
        /** Normalized path relative to the immutable model snapshot. */
        readonly sourcePath: string;
        /** Digest required before model-snapshot code can enter the runtime package. */
        readonly digest: string;
        /** Normalized absolute destination inside the pinned vLLM image. */
        readonly targetPath: string;
      };
      readonly exactTextReplacement: {
        /** Normalized absolute file inside the pinned vLLM package. */
        readonly targetPath: string;
        readonly expectedText: string;
        readonly replacementText: string;
      };
    };

interface ManagedClusterVllmPreparationPlanBase {
  readonly phase: "container-before-exec";
  readonly modelId: string;
  readonly modelRevision: string;
  readonly modelDownloadSizeBytes: number;
}

export type ManagedClusterVllmPreparationPlan =
  | (ManagedClusterVllmPreparationPlanBase & { readonly ref: typeof NO_PREPARATION_REF })
  | (ManagedClusterVllmPreparationPlanBase & {
      readonly ref: typeof SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF;
      readonly snapshotCopy: {
        readonly sourcePath: string;
        readonly digest: string;
        readonly targetPath: string;
      };
      readonly exactTextReplacement: {
        readonly targetPath: string;
        readonly expectedText: string;
        readonly replacementText: string;
      };
    });

interface PreparationModel {
  readonly id: string;
  readonly revision: string;
  readonly downloadSizeBytes: number;
  readonly preparation: unknown;
  readonly modelCacheTarget: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`${label} fields are invalid`);
  }
}

function boundedText(value: unknown, label: string, maximum = MAX_REPLACEMENT_BYTES): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    value.includes("\0")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function snapshotRelativePath(value: unknown): string {
  const candidate = boundedText(value, "snapshot copy source path", MAX_PATH_BYTES);
  if (
    path.posix.isAbsolute(candidate) ||
    path.posix.normalize(candidate) !== candidate ||
    candidate === "." ||
    candidate.startsWith("../") ||
    candidate.includes(":")
  ) {
    throw new Error("snapshot copy source path must be a normalized relative POSIX path");
  }
  return candidate;
}

function containerPath(value: unknown, label: string): string {
  const candidate = boundedText(value, label, MAX_PATH_BYTES);
  if (
    !path.posix.isAbsolute(candidate) ||
    path.posix.normalize(candidate) !== candidate ||
    candidate === "/"
  ) {
    throw new Error(`${label} must be a normalized absolute container path`);
  }
  return candidate;
}

function preparationRecipe(value: unknown): ManagedClusterVllmPreparationRecipe {
  if (!isRecord(value)) throw new Error("model preparation must be an object");
  if (value.ref === NO_PREPARATION_REF) {
    exactKeys(value, ["ref"], "model preparation");
    return { ref: NO_PREPARATION_REF };
  }
  exactKeys(value, ["exactTextReplacement", "ref", "snapshotCopy"], "model preparation");
  if (value.ref !== SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF) {
    throw new Error(`unsupported model preparation ${String(value.ref)}`);
  }
  if (!isRecord(value.snapshotCopy)) throw new Error("snapshot copy preparation is invalid");
  exactKeys(
    value.snapshotCopy,
    ["digest", "sourcePath", "targetPath"],
    "snapshot copy preparation",
  );
  if (!isRecord(value.exactTextReplacement)) {
    throw new Error("exact-text replacement preparation is invalid");
  }
  exactKeys(
    value.exactTextReplacement,
    ["expectedText", "replacementText", "targetPath"],
    "exact-text replacement preparation",
  );
  const expectedText = boundedText(
    value.exactTextReplacement.expectedText,
    "exact-text replacement expected text",
  );
  const replacementText = boundedText(
    value.exactTextReplacement.replacementText,
    "exact-text replacement replacement text",
  );
  if (expectedText === replacementText) {
    throw new Error("exact-text replacement must change the matched text");
  }
  if (
    typeof value.snapshotCopy.digest !== "string" ||
    !SHA256_DIGEST.test(value.snapshotCopy.digest)
  ) {
    throw new Error("snapshot copy digest must be an exact SHA-256 digest");
  }
  return {
    ref: SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
    snapshotCopy: {
      sourcePath: snapshotRelativePath(value.snapshotCopy.sourcePath),
      digest: value.snapshotCopy.digest,
      targetPath: containerPath(value.snapshotCopy.targetPath, "snapshot copy target path"),
    },
    exactTextReplacement: {
      targetPath: containerPath(
        value.exactTextReplacement.targetPath,
        "exact-text replacement target path",
      ),
      expectedText,
      replacementText,
    },
  };
}

/** Materialize one allowlisted, non-executable preparation operation from recipe data. */
export function materializeManagedClusterVllmPreparation(
  model: PreparationModel,
): ManagedClusterVllmPreparationPlan {
  if (!MODEL_ID.test(model.id) || !MODEL_REVISION.test(model.revision)) {
    throw new Error("model preparation identity is invalid");
  }
  if (!Number.isSafeInteger(model.downloadSizeBytes) || model.downloadSizeBytes <= 0) {
    throw new Error("model preparation download size is invalid");
  }
  const modelCacheTarget = containerPath(model.modelCacheTarget, "model cache target");
  const preparation = preparationRecipe(model.preparation);
  const base = {
    phase: "container-before-exec" as const,
    modelId: model.id,
    modelRevision: model.revision,
    modelDownloadSizeBytes: model.downloadSizeBytes,
  };
  if (preparation.ref === NO_PREPARATION_REF) {
    return { ...base, ref: NO_PREPARATION_REF };
  }
  const snapshotRoot = `${modelCacheTarget}/hub/models--${model.id.replaceAll(
    "/",
    "--",
  )}/snapshots/${model.revision}`;
  return {
    ...base,
    ref: preparation.ref,
    snapshotCopy: {
      sourcePath: `${snapshotRoot}/${preparation.snapshotCopy.sourcePath}`,
      digest: preparation.snapshotCopy.digest,
      targetPath: preparation.snapshotCopy.targetPath,
    },
    exactTextReplacement: preparation.exactTextReplacement,
  };
}
