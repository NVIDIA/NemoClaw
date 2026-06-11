// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { run, runWithInput } from "./helpers";

describe("credentials CLI dispatch", () => {
  it("credentials help exits 0 and shows credential subcommands", () => {
    const r = run("credentials --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("USAGE");
    expect(r.out).toContain("$ nemoclaw credentials <list|reset>");
    expect(r.out).toContain("credentials list");
    expect(r.out).toContain("credentials reset");
  });

  it("credentials list --help exits 0 and shows list usage", () => {
    const r = run("credentials list --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("credentials list");
    expect(r.out).toContain("List provider credentials");
  });

  it("credentials reset without provider uses oclif required-arg validation", () => {
    const r = run("credentials reset --yes");
    expect(r.code).toBe(2);
    expect(r.out).toContain("Missing 1 required arg");
    expect(r.out).toContain("provider  OpenShell provider name");
  });

  it("credentials reset without provider ignores poisoned stdin", () => {
    const r = runWithInput("credentials reset --yes", "/usr/bin/dmesg\n3");
    expect(r.code).toBe(2);
    expect(r.out).toContain("Missing 1 required arg");
    expect(r.out).toContain("provider  OpenShell provider name");
    expect(r.out).not.toContain("Could not remove provider");
  });
});
