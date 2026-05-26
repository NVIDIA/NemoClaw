// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  resolveSaveHostPath,
  saveBackupToHost,
} from "../../../dist/lib/state/save-host";

describe("resolveSaveHostPath", () => {
  it("expands a leading ~/ to the home directory", () => {
    expect(resolveSaveHostPath("~/backups", "/home/user")).toBe("/home/user/backups");
  });

  it("expands a bare ~ to the home directory", () => {
    expect(resolveSaveHostPath("~", "/home/user")).toBe("/home/user");
  });

  it("resolves relative paths against the current working directory", () => {
    const result = resolveSaveHostPath("./out", "/home/user");
    expect(path.isAbsolute(result)).toBe(true);
    expect(result.endsWith("/out")).toBe(true);
  });

  it("returns absolute paths unchanged", () => {
    expect(resolveSaveHostPath("/var/backups/nemoclaw", "/home/user")).toBe(
      "/var/backups/nemoclaw",
    );
  });
});

describe("saveBackupToHost", () => {
  it("copies the backup directory into the resolved destination under <sandbox>/<timestamp> and reports ok", () => {
    const cp = vi.fn();
    const mkdir = vi.fn();
    const result = saveBackupToHost(
      "/home/user/.nemoclaw/rebuild-backups/my-assistant/2026-05-26T00-00-00Z",
      "/var/backups/nemoclaw",
      cp,
      mkdir,
      "/home/user",
    );
    expect(result.ok).toBe(true);
    expect(result.destination).toBe(
      "/var/backups/nemoclaw/my-assistant/2026-05-26T00-00-00Z",
    );
    expect(mkdir).toHaveBeenCalledWith("/var/backups/nemoclaw/my-assistant", { recursive: true });
    expect(cp).toHaveBeenCalledWith(
      "/home/user/.nemoclaw/rebuild-backups/my-assistant/2026-05-26T00-00-00Z",
      "/var/backups/nemoclaw/my-assistant/2026-05-26T00-00-00Z",
      { recursive: true },
    );
  });

  it("expands ~ in the destination path before copying", () => {
    const cp = vi.fn();
    const mkdir = vi.fn();
    const result = saveBackupToHost(
      "/home/user/.nemoclaw/rebuild-backups/my-assistant/2026-05-26",
      "~/nemoclaw-backups",
      cp,
      mkdir,
      "/home/user",
    );
    expect(result.ok).toBe(true);
    expect(result.destination).toBe(
      "/home/user/nemoclaw-backups/my-assistant/2026-05-26",
    );
  });

  it("returns ok:false with the underlying error message when copy fails", () => {
    const cp = vi.fn(() => {
      throw new Error("EACCES: permission denied");
    });
    const mkdir = vi.fn();
    const result = saveBackupToHost("/state/backup/2026", "/protected", cp, mkdir, "/home/user");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("EACCES: permission denied");
  });

  it("refuses to save when the destination resolves inside ~/.nemoclaw", () => {
    const cp = vi.fn();
    const mkdir = vi.fn();
    const result = saveBackupToHost(
      "/home/user/.nemoclaw/rebuild-backups/my-assistant/2026-05-26",
      "~/.nemoclaw/escape-hatch",
      cp,
      mkdir,
      "/home/user",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Refusing to save backups under /home/user/.nemoclaw");
    expect(cp).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it("refuses to save when the destination is exactly ~/.nemoclaw", () => {
    const cp = vi.fn();
    const mkdir = vi.fn();
    const result = saveBackupToHost(
      "/home/user/.nemoclaw/rebuild-backups/my-assistant/2026-05-26",
      "/home/user/.nemoclaw",
      cp,
      mkdir,
      "/home/user",
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Refusing to save backups under /home/user/.nemoclaw");
    expect(cp).not.toHaveBeenCalled();
  });

  it("allows a sibling directory next to ~/.nemoclaw", () => {
    const cp = vi.fn();
    const mkdir = vi.fn();
    const result = saveBackupToHost(
      "/home/user/.nemoclaw/rebuild-backups/my-assistant/2026-05-26",
      "/home/user/.nemoclaw-backups",
      cp,
      mkdir,
      "/home/user",
    );
    expect(result.ok).toBe(true);
    expect(result.destination).toBe(
      "/home/user/.nemoclaw-backups/my-assistant/2026-05-26",
    );
  });
});
