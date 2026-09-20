// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  BACKUP_FAILURE_ABSENT_AFTER_EXTRACTION,
  BACKUP_FAILURE_PERMISSION_DENIED,
  BACKUP_FAILURE_TAR_READ_ERROR,
  classifyFailedDirsFromTarStderr,
  formatFailedBackupItems,
  recordFailedBackupDir,
  relativeFailedBackupDir,
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

  it("records a failed directory only once and keeps the first reason", () => {
    const failedDirs: string[] = [];
    const reasons: Record<string, string> = {};
    recordFailedBackupDir(failedDirs, "workspace", reasons, BACKUP_FAILURE_PERMISSION_DENIED);
    recordFailedBackupDir(failedDirs, "workspace", reasons, BACKUP_FAILURE_TAR_READ_ERROR);
    recordFailedBackupDir(failedDirs, "workspace");
    expect(failedDirs).toEqual(["workspace"]);
    expect(reasons).toEqual({ workspace: BACKUP_FAILURE_PERMISSION_DENIED });
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

  it("maps an unreadable audit path onto its declared backup directory", () => {
    expect(
      relativeFailedBackupDir("/sandbox/.openclaw/workspace/restricted", "/sandbox/.openclaw/", [
        "agents",
        "workspace",
      ]),
    ).toBe("workspace/restricted");
    expect(
      relativeFailedBackupDir("/sandbox/.openclaw/workspace", "/sandbox/.openclaw/", ["workspace"]),
    ).toBe("workspace");
  });

  it("maps an unreadable path under a nested declared directory", () => {
    expect(
      relativeFailedBackupDir("/sandbox/.openclaw/agents/main/restricted", "/sandbox/.openclaw/", [
        "agents/main",
      ]),
    ).toBe("agents/main/restricted");
    expect(
      relativeFailedBackupDir("/sandbox/.openclaw/agents/main", "/sandbox/.openclaw/", [
        "agents/main",
      ]),
    ).toBe("agents/main");
    expect(
      relativeFailedBackupDir("/sandbox/.openclaw/agents/maintenance", "/sandbox/.openclaw/", [
        "agents/main",
      ]),
    ).toBeNull();
  });

  it("rejects undeclared or unsafe unreadable audit paths", () => {
    expect(
      relativeFailedBackupDir("/sandbox/.openclaw/../etc", "/sandbox/.openclaw/", ["workspace"]),
    ).toBeNull();
    expect(
      relativeFailedBackupDir("/sandbox/.openclaw/identity/tokens", "/sandbox/.openclaw/", [
        "workspace",
      ]),
    ).toBeNull();
    expect(relativeFailedBackupDir("/etc/shadow", "/sandbox/.openclaw/", ["workspace"])).toBeNull();
  });
});
