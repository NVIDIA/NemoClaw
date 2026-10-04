// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  BACKUP_FAILURE_ABSENT_AFTER_EXTRACTION,
  BACKUP_FAILURE_PERMISSION_DENIED,
  BACKUP_FAILURE_TAR_READ_ERROR,
  classifyFailedDirsFromTarStderr,
  formatFailedBackupItems,
} from "./backup-failure";

describe("backup failure diagnostics", () => {
  it("classifies permission and generic tar read errors by directory", () => {
    const failures = classifyFailedDirsFromTarStderr(
      [
        "tar: agents/main/session.json: Cannot read: Input/output error",
        "tar: workspace/marker.txt: Cannot read: Input/output error",
        "tar: agents/main/session.json: Cannot open: Permission denied",
        "tar: unrelated/file: Cannot read: Input/output error",
      ].join("\n"),
      ["agents", "agents/main", "workspace"],
    );

    expect(Object.fromEntries(failures)).toEqual({
      "agents/main": BACKUP_FAILURE_PERMISSION_DENIED,
      workspace: BACKUP_FAILURE_TAR_READ_ERROR,
    });
  });

  it("renders known reasons while preserving uncategorized items", () => {
    expect(
      formatFailedBackupItems(["identity", "credentials", "settings.json"], {
        credentials: BACKUP_FAILURE_ABSENT_AFTER_EXTRACTION,
        identity: BACKUP_FAILURE_PERMISSION_DENIED,
      }),
    ).toBe("identity (permission denied), credentials (absent after extraction), settings.json");
    expect(formatFailedBackupItems(["memories", "settings.json"], undefined)).toBe(
      "memories, settings.json",
    );
  });
});
