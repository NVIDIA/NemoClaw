// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { openRegularFileNoFollow } from "./regular-file";

describe("regular file adapter", () => {
  it("creates and replaces a private regular file through one descriptor", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-regular-file-"));
    const filePath = path.join(tmp, "gateway.env");

    try {
      const file = openRegularFileNoFollow(filePath, {
        create: true,
        mode: 0o600,
        writable: true,
      });
      file.replaceUtf8("created\n", 0o600);
      file.close();

      expect(fs.readFileSync(filePath, "utf-8")).toBe("created\n");
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads and replaces a regular file through one descriptor", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-regular-file-"));
    const filePath = path.join(tmp, "gateway.env");
    fs.writeFileSync(filePath, "before\n");

    try {
      const file = openRegularFileNoFollow(filePath, { writable: true });
      expect(file.readUtf8()).toBe("before\n");
      expect(file.readUtf8()).toBe("before\n");
      file.replaceUtf8("after\n", 0o600);
      file.close();

      expect(fs.readFileSync(filePath, "utf-8")).toBe("after\n");
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to follow a symbolic link", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-regular-file-"));
    const targetPath = path.join(tmp, "target");
    const linkPath = path.join(tmp, "link");
    fs.writeFileSync(targetPath, "foreign\n");
    fs.symlinkSync(targetPath, linkPath);

    try {
      expect(() => openRegularFileNoFollow(linkPath)).toThrow();
      expect(fs.readFileSync(targetPath, "utf-8")).toBe("foreign\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
