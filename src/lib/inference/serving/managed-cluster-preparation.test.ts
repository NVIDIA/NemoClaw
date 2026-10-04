// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  NO_PREPARATION_REF,
  SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
} from "./adapter-registry.js";
import { materializeManagedClusterVllmPreparation } from "./managed-cluster-preparation.js";

const MODEL = {
  id: "example-org/Synthetic-Model",
  revision: "a".repeat(64),
  downloadSizeBytes: 1_234_567,
  modelCacheTarget: "/models/alternate-cache",
} as const;

describe("managed cluster vLLM preparation materializer", () => {
  it("materializes the registered no-op without executable input", () => {
    const preparation = materializeManagedClusterVllmPreparation({
      ...MODEL,
      preparation: { ref: NO_PREPARATION_REF },
    });

    expect(preparation).toEqual({
      ref: NO_PREPARATION_REF,
      phase: "container-before-exec",
      modelId: MODEL.id,
      modelRevision: MODEL.revision,
      modelDownloadSizeBytes: MODEL.downloadSizeBytes,
    });
    expect(preparation).not.toHaveProperty("command");
  });

  it("derives the snapshot root and opaque target paths from recipe data", () => {
    const preparation = materializeManagedClusterVllmPreparation({
      ...MODEL,
      preparation: {
        ref: SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
        snapshotCopy: {
          sourcePath: "artifacts/tokenizer.py",
          digest: `sha256:${"4".repeat(64)}`,
          targetPath: "/opt/alternate-vllm/tokenizers/model.py",
        },
        exactTextReplacement: {
          targetPath: "/opt/alternate-vllm/parsers/reasoning.py",
          expectedText: "MODE = 'before'",
          replacementText: "MODE = 'after'",
        },
      },
    });

    expect(preparation).toEqual({
      ref: SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
      phase: "container-before-exec",
      modelId: MODEL.id,
      modelRevision: MODEL.revision,
      modelDownloadSizeBytes: MODEL.downloadSizeBytes,
      snapshotCopy: {
        sourcePath: `/models/alternate-cache/hub/models--example-org--Synthetic-Model/snapshots/${MODEL.revision}/artifacts/tokenizer.py`,
        digest: `sha256:${"4".repeat(64)}`,
        targetPath: "/opt/alternate-vllm/tokenizers/model.py",
      },
      exactTextReplacement: {
        targetPath: "/opt/alternate-vllm/parsers/reasoning.py",
        expectedText: "MODE = 'before'",
        replacementText: "MODE = 'after'",
      },
    });
    expect(preparation).not.toHaveProperty("command");
  });

  it.each([
    {
      label: "snapshot traversal",
      error: /snapshot copy source path must be a normalized relative POSIX path/u,
      preparation: {
        ref: SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
        snapshotCopy: {
          sourcePath: "../escape.py",
          digest: `sha256:${"4".repeat(64)}`,
          targetPath: "/opt/vllm/copied.py",
        },
        exactTextReplacement: {
          targetPath: "/opt/vllm/reasoning.py",
          expectedText: "before",
          replacementText: "after",
        },
      },
    },
    {
      label: "relative container target",
      error: /snapshot copy target path must be a normalized absolute container path/u,
      preparation: {
        ref: SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
        snapshotCopy: {
          sourcePath: "safe.py",
          digest: `sha256:${"4".repeat(64)}`,
          targetPath: "relative/copied.py",
        },
        exactTextReplacement: {
          targetPath: "/opt/vllm/reasoning.py",
          expectedText: "before",
          replacementText: "after",
        },
      },
    },
    {
      label: "invalid snapshot digest",
      error: /snapshot copy digest must be an exact SHA-256 digest/u,
      preparation: {
        ref: SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
        snapshotCopy: {
          sourcePath: "safe.py",
          digest: "sha256:not-a-digest",
          targetPath: "/opt/vllm/copied.py",
        },
        exactTextReplacement: {
          targetPath: "/opt/vllm/reasoning.py",
          expectedText: "before",
          replacementText: "after",
        },
      },
    },
    {
      label: "unchanged replacement",
      error: /exact-text replacement must change the matched text/u,
      preparation: {
        ref: SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
        snapshotCopy: {
          sourcePath: "safe.py",
          digest: `sha256:${"4".repeat(64)}`,
          targetPath: "/opt/vllm/copied.py",
        },
        exactTextReplacement: {
          targetPath: "/opt/vllm/reasoning.py",
          expectedText: "same",
          replacementText: "same",
        },
      },
    },
  ])("rejects bounded operation input with $label", ({ error, preparation }) => {
    expect(() => materializeManagedClusterVllmPreparation({ ...MODEL, preparation })).toThrow(
      error,
    );
  });
});
