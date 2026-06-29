// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { run, runWithInput } from "./helpers";

describe("credentials CLI dispatch", () => {
  it("credentials help exits 0 and shows credential subcommands", () => {
    const r = run("credentials --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("USAGE");
    expect(r.out).toContain("$ nemoclaw credentials <list|add|reset>");
    expect(r.out).toContain("credentials list");
    expect(r.out).toContain("credentials add");
    expect(r.out).toContain("credentials reset");
  });

  it("credentials list --help exits 0 and shows list usage", () => {
    const r = run("credentials list --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("credentials list");
    expect(r.out).toContain("List provider credentials");
  });

  it("credentials add --help exits 0 and shows add usage", () => {
    const r = run("credentials add --help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("credentials add");
    expect(r.out).toContain("Register a provider credential");
    expect(r.out).toContain("--type");
    expect(r.out).toContain("--credential");
    expect(r.out).toContain("--from-existing");
  });

  it("credentials add without provider uses oclif required-arg validation", () => {
    const r = run("credentials add --type tavily --credential TAVILY_API_KEY");
    expect(r.code).toBe(2);
    expect(r.out).toContain("Missing 1 required arg");
    expect(r.out).toContain("provider  OpenShell provider name");
  });

  it("credentials add without --type uses oclif required-flag validation", () => {
    const r = run("credentials add tavily-search --credential TAVILY_API_KEY");
    expect(r.code).toBe(2);
    expect(r.out).toContain("Missing required flag type");
  });

  it("credentials add without --credential or --from-existing fails with explicit guidance", () => {
    const r = run("credentials add tavily-search --type tavily");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("At least one --credential KEY or --from-existing is required.");
  });

  it("credentials add rejects --from-existing combined with --credential", () => {
    const r = run("credentials add foo --type generic --from-existing --credential FOO_TOKEN");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--from-existing cannot be combined with --credential.");
  });

  it("credentials add rejects inline KEY=VALUE credentials without echoing the value", () => {
    const r = run(
      "credentials add tavily-search --type tavily --credential TAVILY_API_KEY=tvly-secret-12345",
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--credential expects an env variable name, not 'KEY=VALUE'");
    expect(r.out).not.toContain("tvly-secret-12345");
  });

  it("credentials add rejects --credential values that are not uppercase env names", () => {
    const r = run("credentials add tavily-search --type tavily --credential tavily-api-key");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("--credential must be a valid env variable name");
    expect(r.out).not.toContain("tavily-api-key");
  });

  it("credentials add never echoes a secret-shaped --credential value", () => {
    const r = run(
      "credentials add tavily-search --type tavily --credential tvly-secret-leaked-9999",
    );
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("tvly-secret-leaked-9999");
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
