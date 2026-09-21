// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ConfigExportFailure } from "../actions/config/export";
import type {
  YamlExportFailure,
  YamlExportFailureKind,
  YamlExportFileState,
} from "../adapters/fs/config-export-file";

function fileDiagnostic(category: YamlExportFailureKind, fileState: YamlExportFileState): string {
  switch (fileState.publication) {
    case "unknown":
      return fileState.stagingCleanup === "incomplete"
        ? "The export publication state and staging cleanup could not be confirmed."
        : "The export may have been written, but its publication state could not be confirmed.";
    case "not-published":
      if (fileState.stagingCleanup === "incomplete") {
        return "The export was not published, and its staging file could not be removed.";
      }
      return category === "output-conflict"
        ? "The output path already exists."
        : "The output path could not be published safely.";
    case "published":
      return publishedDiagnostic(fileState);
    default:
      fileState satisfies never;
      throw new Error("Unexpected export publication state");
  }
}

function publishedDiagnostic(
  fileState: Extract<YamlExportFileState, { publication: "published" }>,
): string {
  const concerns = [
    ...(fileState.durability === "unknown" ? ["filesystem durability"] : []),
    ...(fileState.location === "unknown" ? ["the final output location"] : []),
    ...(fileState.stagingCleanup === "incomplete" ? ["staging cleanup"] : []),
  ];
  return concerns.length > 0
    ? `The export was written, but ${concerns.join(", ")} could not be confirmed.`
    : "The export was written, but output finalization failed.";
}

function stagingDiagnostic(failure: YamlExportFailure): string {
  if (failure.fileState.stagingCleanup !== "incomplete") return "";
  const reference = failure.stagingReference;
  if (reference === null) {
    return " The staging identity is unavailable. Do not remove files by name alone.";
  }
  return (
    ` Staging file: ${reference.name}; device ${reference.fileDevice}, inode ${reference.fileInode}.` +
    ` Original output directory: device ${reference.directoryDevice}, inode ${reference.directoryInode}.` +
    " Locate that directory, which may have moved. Before manual removal, verify both identities and that the staging entry is a regular file." +
    " Do not remove the requested output file."
  );
}

export function formatConfigExportFailure(failure: ConfigExportFailure): string {
  if (failure.kind === "observation") {
    const categories = [...new Set(failure.findings.map(({ category }) => category))];
    return [
      `Config export failed (${categories.join(", ")}).`,
      ...failure.findings.map(({ diagnostic }) => diagnostic),
    ].join("\n");
  }
  const diagnostic =
    failure.target === "stdout"
      ? "The export could not be written to stdout."
      : fileDiagnostic(failure.category, failure.fileState) + stagingDiagnostic(failure);
  return `Config export failed (${failure.category}): ${diagnostic}`;
}
