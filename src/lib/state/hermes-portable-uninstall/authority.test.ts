// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inspectHermesPortableUninstallDirectoryAuthority } from "./authority";

let homeDir: string;

beforeEach(() => {
  vi.restoreAllMocks();
  homeDir = fs.mkdtempSync(`${os.tmpdir()}/nemoclaw-hermes-uninstall-authority-`);
});

afterEach(() => {
  fs.rmSync(homeDir, { force: true, recursive: true });
});

describe("Hermes Portable uninstall state authority", () => {
  it("rejects same-name recovery authority replacement after opening the original file (#9608)", () => {
    const authorityDirectory = path.join(homeDir, "recovery-authority");
    const authorityFile = path.join(authorityDirectory, "receipt.json");
    const displacedFile = `${authorityFile}.displaced`;
    fs.mkdirSync(authorityDirectory, { mode: 0o700 });
    fs.writeFileSync(authorityFile, "original", { mode: 0o600 });

    const originalLstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, "lstatSync")
      .mockImplementationOnce(originalLstat)
      .mockImplementationOnce(((target, options) => {
        expect(path.resolve(String(target))).toBe(path.resolve(authorityFile));
        fs.renameSync(authorityFile, displacedFile);
        fs.writeFileSync(authorityFile, "replacement", { mode: 0o600 });
        return originalLstat(target, options as never);
      }) as typeof fs.lstatSync);

    expect(() => inspectHermesPortableUninstallDirectoryAuthority(authorityDirectory)).toThrow(
      "Hermes Portable uninstall authority entry is unsafe",
    );
  });
});
