// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  jsonObject,
  readJsonObject,
  rejectUnsafePackageTree,
  requireRealDirectory,
} from "../../scripts/lib/bundled-npm-package.mts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-npm-package-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("bundled npm package utilities", () => {
  it("accepts a real JSON object without following file or directory symlinks", () => {
    const root = temporaryDirectory();
    const manifest = path.join(root, "package.json");
    fs.writeFileSync(manifest, '{"name":"npm"}\n');
    expect(jsonObject({ name: "npm" }, "manifest")).toEqual({ name: "npm" });
    expect(() => jsonObject([], "manifest")).toThrow("manifest must be a JSON object");
    expect(readJsonObject(manifest, "npm manifest")).toEqual({ name: "npm" });
    expect(requireRealDirectory(root, "npm root")).toBe(fs.realpathSync(root));

    const fileLink = path.join(root, "package-link.json");
    fs.symlinkSync("package.json", fileLink);
    expect(() => readJsonObject(fileLink, "npm manifest")).toThrow();
    const directoryLink = path.join(temporaryDirectory(), "npm-link");
    fs.symlinkSync(root, directoryLink);
    expect(() => requireRealDirectory(directoryLink, "npm root")).toThrow(
      `npm root must be a real directory: ${directoryLink}`,
    );
  });

  it("accepts regular nested trees and rejects symlinked members", () => {
    const root = temporaryDirectory();
    const nested = path.join(root, "lib");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "index.js"), "export {};\n");
    expect(() => rejectUnsafePackageTree(root, "replacement package")).not.toThrow();

    fs.symlinkSync("lib/index.js", path.join(root, "unsafe-link"));
    expect(() => rejectUnsafePackageTree(root, "replacement package")).toThrow(
      "replacement package contains an unsafe member: unsafe-link",
    );
  });
});
