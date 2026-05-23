// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";

import { npmGlobalBin, npmLinkTargetPaths, npmLinkTargetsWritable, pathWithPrependedEntries } from "./npm";

function state(options: { existing?: string[]; writable?: string[] }) {
  const existing = new Set(options.existing ?? []);
  const writable = new Set(options.writable ?? []);
  return {
    exists: (targetPath: string) => existing.has(targetPath),
    isWritable: (targetPath: string) => writable.has(targetPath),
  };
}

describe("installer npm helpers", () => {
  it("resolves npm global bin and target paths", () => {
    expect(npmGlobalBin("/tmp/prefix")).toBe(path.join("/tmp/prefix", "bin"));
    expect(npmGlobalBin("  ")).toBeNull();
    expect(npmLinkTargetPaths("/tmp/prefix")).toEqual({
      binDir: path.join("/tmp/prefix", "bin"),
      libDir: path.join("/tmp/prefix", "lib"),
      nodeModulesDir: path.join("/tmp/prefix", "lib", "node_modules"),
      prefix: "/tmp/prefix",
    });
  });

  it("matches npm_link_targets_writable shell semantics", () => {
    const paths = npmLinkTargetPaths("/tmp/prefix");
    expect(
      npmLinkTargetsWritable(
        "/tmp/prefix",
        state({ existing: [paths.binDir, paths.nodeModulesDir], writable: [paths.binDir, paths.nodeModulesDir] }),
      ).ok,
    ).toBe(true);
    expect(
      npmLinkTargetsWritable("/tmp/prefix", state({ existing: [paths.binDir], writable: [paths.nodeModulesDir] })),
    ).toEqual({ ok: false, paths, reason: "bin-unwritable" });
    expect(
      npmLinkTargetsWritable("/tmp/prefix", state({ existing: [paths.libDir], writable: [paths.prefix] })),
    ).toEqual({ ok: false, paths, reason: "lib-unwritable" });
    expect(npmLinkTargetsWritable("", state({}))).toEqual({
      ok: false,
      paths: npmLinkTargetPaths(""),
      reason: "empty-prefix",
    });
  });

  it("prepends missing PATH entries without duplicating existing ones", () => {
    const current = ["/usr/bin", "/bin"].join(path.delimiter);
    expect(pathWithPrependedEntries(current, ["/tmp/npm/bin", "/usr/bin"])).toBe(
      ["/tmp/npm/bin", "/usr/bin", "/bin"].join(path.delimiter),
    );
  });
});
