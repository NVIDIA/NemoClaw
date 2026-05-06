// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { classifyNemoclawShim, DEV_SHIM_MARKER, isDevShimContents, isInstallerManagedWrapperContents } from "./shims";

function wrapper(extra = ""): string {
  return ["#!/usr/bin/env bash", 'export PATH="/tmp/node-bin:$PATH"', 'exec "/tmp/prefix/bin/nemoclaw" "$@"', extra]
    .filter((line) => line !== undefined)
    .join("\n");
}

describe("uninstall shim classification", () => {
  it("classifies symlinks as managed shims", () => {
    expect(classifyNemoclawShim({ exists: true, isFile: false, isSymlink: true })).toMatchObject({
      kind: "managed-symlink",
      remove: true,
    });
  });

  it("recognizes installer-managed wrapper files", () => {
    const contents = wrapper("");
    expect(isInstallerManagedWrapperContents(contents)).toBe(true);
    expect(classifyNemoclawShim({ contents, exists: true, isFile: true, isSymlink: false })).toMatchObject({
      kind: "managed-wrapper",
      remove: true,
    });
  });

  it("recognizes dev-install shims from npm-link-or-shim", () => {
    const contents = [
      "#!/usr/bin/env bash",
      DEV_SHIM_MARKER,
      'export PATH="/tmp/node-bin:$PATH"',
      'exec "/tmp/checkout/bin/nemoclaw.js" "$@"',
      "",
    ].join("\n");

    expect(isDevShimContents(contents)).toBe(true);
    expect(classifyNemoclawShim({ contents, exists: true, isFile: true, isSymlink: false })).toMatchObject({
      kind: "managed-dev-shim",
      remove: true,
    });
  });

  it("preserves user-managed and wrapper-like files with extra content", () => {
    expect(
      classifyNemoclawShim({
        contents: "#!/usr/bin/env bash\necho user\n",
        exists: true,
        isFile: true,
        isSymlink: false,
      }),
    ).toMatchObject({ kind: "preserve-foreign-file", remove: false });

    expect(
      classifyNemoclawShim({
        contents: wrapper("echo user-extra"),
        exists: true,
        isFile: true,
        isSymlink: false,
      }),
    ).toMatchObject({ kind: "preserve-foreign-file", remove: false });
  });

  it("treats missing and non-regular paths as no-remove cases", () => {
    expect(classifyNemoclawShim({ exists: false, isFile: false, isSymlink: false })).toMatchObject({
      kind: "missing",
      remove: false,
    });
    expect(classifyNemoclawShim({ exists: true, isFile: false, isSymlink: false })).toMatchObject({
      kind: "unsupported-path-type",
      remove: false,
    });
  });
});
