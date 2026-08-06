// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPrivateCredentialFile } from "./private-credential";

const value = "owner-only-credential-value-with-32-bytes";

function fixture(mode = 0o600) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-voice-credential-"));
  const file = path.join(directory, "credential");
  fs.writeFileSync(file, `${value}\n`, { mode });
  return { directory, file };
}

describe("private voice credential files", () => {
  it("reads an owner-only regular file with one trailing newline (#8378)", () => {
    const item = fixture();
    try {
      expect(readPrivateCredentialFile(item.file, "Voice credential")).toBe(value);
    } finally {
      fs.rmSync(item.directory, { recursive: true, force: true });
    }
  });

  it("rejects symbolic links and group-readable files (#8378)", () => {
    const item = fixture(0o640);
    const link = path.join(item.directory, "link");
    fs.symlinkSync(item.file, link);
    try {
      expect(() => readPrivateCredentialFile(item.file, "Voice credential")).toThrow(
        "group or others",
      );
      expect(() => readPrivateCredentialFile(link, "Voice credential")).toThrow(
        "must not be a symbolic link",
      );
    } finally {
      fs.rmSync(item.directory, { recursive: true, force: true });
    }
  });

  it("rejects relative, malformed, and oversized values (#8378)", () => {
    const item = fixture();
    try {
      expect(() => readPrivateCredentialFile("relative", "Voice credential")).toThrow("absolute");
      fs.writeFileSync(item.file, "short", { mode: 0o600 });
      expect(() => readPrivateCredentialFile(item.file, "Voice credential")).toThrow("malformed");
      fs.writeFileSync(item.file, "a".repeat(5000), { mode: 0o600 });
      expect(() => readPrivateCredentialFile(item.file, "Voice credential")).toThrow(
        "invalid size",
      );
    } finally {
      fs.rmSync(item.directory, { recursive: true, force: true });
    }
  });

  it("rejects a credential reached through a symbolic-link directory (#8378)", () => {
    const item = fixture();
    const originalHome = process.env.HOME;
    process.env.HOME = item.directory;
    const realDirectory = path.join(item.directory, "real-parent");
    const linkDirectory = path.join(item.directory, "linked-parent");
    fs.mkdirSync(realDirectory);
    fs.writeFileSync(path.join(realDirectory, "credential"), value, { mode: 0o600 });
    fs.symlinkSync(realDirectory, linkDirectory);
    try {
      expect(() =>
        readPrivateCredentialFile(path.join(linkDirectory, "credential"), "Voice credential"),
      ).toThrow("symlink");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      fs.rmSync(item.directory, { recursive: true, force: true });
    }
  });
});
