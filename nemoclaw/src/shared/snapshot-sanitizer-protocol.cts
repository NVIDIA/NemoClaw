// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const MAX_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_SNAPSHOT_FILE_BASE64_LENGTH = Math.ceil(MAX_SNAPSHOT_FILE_BYTES / 3) * 4;

export interface SnapshotFileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
  readonly nlink: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface SnapshotScannedFile {
  readonly path: string;
  readonly metadata: SnapshotFileIdentity;
  readonly content?: string;
}

export interface DescriptorSnapshotRoot {
  readonly canonicalPath: string;
  readonly identity: SnapshotFileIdentity;
}

export interface DescriptorSnapshotScan {
  readonly root: SnapshotFileIdentity;
  readonly files: readonly SnapshotScannedFile[];
}

export type SnapshotSanitizationAction =
  | {
      readonly kind: "remove";
      readonly path: string;
      readonly metadata: SnapshotFileIdentity;
    }
  | {
      readonly kind: "replace";
      readonly path: string;
      readonly metadata: SnapshotFileIdentity;
      readonly content: string;
    };

export type SnapshotSanitizerFailureCode =
  | "snapshot-entry-limit-exceeded"
  | "snapshot-size-limit-exceeded"
  | "snapshot-scan-failed"
  | "snapshot-mutation-failed"
  | "native-probe-failed"
  | "helper-process-failed";

export type SnapshotSanitizerHelperRequest = Readonly<{
  root: DescriptorSnapshotRoot;
  sensitiveNames?: readonly string[];
  targetName?: string;
  scan?: DescriptorSnapshotScan;
  actions?: readonly SnapshotSanitizationAction[];
  name?: string;
  content?: string;
}>;

export type SnapshotSanitizerHelperResponse =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly prerequisite?: boolean;
      readonly code?: SnapshotSanitizerFailureCode;
    };

export const SNAPSHOT_SANITIZER_FAILURE_CODES: ReadonlySet<SnapshotSanitizerFailureCode> = new Set([
  "snapshot-entry-limit-exceeded",
  "snapshot-size-limit-exceeded",
  "snapshot-scan-failed",
  "snapshot-mutation-failed",
  "native-probe-failed",
  "helper-process-failed",
]);

export function isSnapshotSanitizerFailureCode(
  value: unknown,
): value is SnapshotSanitizerFailureCode {
  return (
    typeof value === "string" &&
    SNAPSHOT_SANITIZER_FAILURE_CODES.has(value as SnapshotSanitizerFailureCode)
  );
}
