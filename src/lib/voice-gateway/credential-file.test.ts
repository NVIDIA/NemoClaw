// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readPrivateBearerFile } from "./credential-file";

const CREDENTIAL = "voice-gateway-test-credential-0123456789";
const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-voice-credential-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("voice gateway credential file", () => {
  it("reads one owner-only regular file and removes one trailing newline (#8378)", () => {
    const file = path.join(temporaryDirectory(), "credential");
    fs.writeFileSync(file, `${CREDENTIAL}\n`, { mode: 0o600 });

    expect(readPrivateBearerFile(file, "Test credential")).toBe(CREDENTIAL);
  });

  it("treats macOS EMLINK as a rejected symbolic link (#8378)", () => {
    const error = Object.assign(new Error("symbolic link"), { code: "EMLINK" });
    vi.spyOn(fs, "openSync").mockImplementationOnce(() => {
      throw error;
    });

    expect(() => readPrivateBearerFile("/absolute/credential", "Test credential")).toThrow(
      "symbolic-link",
    );
  });

  it.each([
    {
      name: "relative path",
      arrange: () => "credential",
      message: "must be absolute",
    },
    {
      name: "group-readable file",
      arrange: () => {
        const file = path.join(temporaryDirectory(), "credential");
        fs.writeFileSync(file, CREDENTIAL, { mode: 0o640 });
        fs.chmodSync(file, 0o640);
        return file;
      },
      message: "must not be accessible by group or others",
    },
    {
      name: "directory",
      arrange: () => temporaryDirectory(),
      message: "not a regular file",
    },
    {
      name: "symbolic link",
      arrange: () => {
        const directory = temporaryDirectory();
        const target = path.join(directory, "target");
        const link = path.join(directory, "credential");
        fs.writeFileSync(target, CREDENTIAL, { mode: 0o600 });
        fs.symlinkSync(target, link);
        return link;
      },
      message: "symbolic-link",
    },
    {
      name: "short value",
      arrange: () => {
        const file = path.join(temporaryDirectory(), "credential");
        fs.writeFileSync(file, "short", { mode: 0o600 });
        return file;
      },
      message: "invalid size",
    },
    {
      name: "value with whitespace",
      arrange: () => {
        const file = path.join(temporaryDirectory(), "credential");
        fs.writeFileSync(file, `${CREDENTIAL} extra`, { mode: 0o600 });
        return file;
      },
      message: "malformed",
    },
    {
      name: "oversized value",
      arrange: () => {
        const file = path.join(temporaryDirectory(), "credential");
        fs.writeFileSync(file, "a".repeat(4098), { mode: 0o600 });
        return file;
      },
      message: "invalid size",
    },
  ])("rejects a $name before returning credential material (#8378)", ({ arrange, message }) => {
    expect(() => readPrivateBearerFile(arrange(), "Test credential")).toThrow(message);
  });
});
