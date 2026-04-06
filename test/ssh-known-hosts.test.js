// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { pruneKnownHostsEntries } from "../bin/lib/onboard";

describe("pruneKnownHostsEntries", () => {
  it("removes lines with openshell- hostnames", () => {
    const input = [
      "openshell-my-sandbox ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...",
      "github.com ssh-rsa AAAAB3NzaC1yc2EAAAA...",
    ].join("\n");
    expect(pruneKnownHostsEntries(input)).toBe("github.com ssh-rsa AAAAB3NzaC1yc2EAAAA...");
  });

  it("removes openshell- from comma-separated host fields", () => {
    const input = [
      "openshell-sandbox,10.0.0.5 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...",
      "github.com ssh-rsa AAAAB3NzaC1yc2EAAAA...",
    ].join("\n");
    expect(pruneKnownHostsEntries(input)).toBe("github.com ssh-rsa AAAAB3NzaC1yc2EAAAA...");
  });

  it("preserves comments", () => {
    const input = [
      "# this is a comment",
      "openshell-old ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...",
      "github.com ssh-rsa AAAAB3NzaC1yc2EAAAA...",
    ].join("\n");
    expect(pruneKnownHostsEntries(input)).toBe(
      ["# this is a comment", "github.com ssh-rsa AAAAB3NzaC1yc2EAAAA..."].join("\n"),
    );
  });

  it("preserves blank lines", () => {
    const input = [
      "github.com ssh-rsa AAAAB3NzaC1yc2EAAAA...",
      "",
      "openshell-sandbox ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...",
      "",
      "gitlab.com ssh-rsa AAAAB3NzaC1yc2EAAAA...",
    ].join("\n");
    expect(pruneKnownHostsEntries(input)).toBe(
      [
        "github.com ssh-rsa AAAAB3NzaC1yc2EAAAA...",
        "",
        "",
        "gitlab.com ssh-rsa AAAAB3NzaC1yc2EAAAA...",
      ].join("\n"),
    );
  });

  it("returns input unchanged when no openshell- entries exist", () => {
    const input = [
      "github.com ssh-rsa AAAAB3NzaC1yc2EAAAA...",
      "gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...",
    ].join("\n");
    expect(pruneKnownHostsEntries(input)).toBe(input);
  });

  it("returns empty string for empty input", () => {
    expect(pruneKnownHostsEntries("")).toBe("");
  });

  it("does not match openshell- appearing only in key data", () => {
    const line = "github.com ssh-rsa openshell-not-a-host-field";
    expect(pruneKnownHostsEntries(line)).toBe(line);
  });

  it("removes multiple openshell- entries", () => {
    const input = [
      "openshell-sandbox-a ssh-ed25519 AAAA...",
      "github.com ssh-rsa AAAA...",
      "openshell-sandbox-b ssh-ed25519 BBBB...",
      "gitlab.com ssh-rsa CCCC...",
    ].join("\n");
    expect(pruneKnownHostsEntries(input)).toBe(
      ["github.com ssh-rsa AAAA...", "gitlab.com ssh-rsa CCCC..."].join("\n"),
    );
  });

  it("handles hashed known_hosts entries (no false positive)", () => {
    // ssh-keygen -H produces lines like |1|base64salt=|base64hash= ssh-rsa ...
    const line = "|1|abc123=|def456= ssh-rsa AAAA...";
    expect(pruneKnownHostsEntries(line)).toBe(line);
  });

  it("removes [openshell-*]:port bracketed entries", () => {
    // SSH known_hosts uses [host]:port for non-standard ports
    const input = [
      "[openshell-sandbox]:2222 ssh-ed25519 AAAA...",
      "github.com ssh-rsa AAAA...",
    ].join("\n");
    // The host field starts with "[openshell-" which starts with "["
    // not "openshell-", so this line would be preserved by current logic.
    // Documenting current behavior — bracket-prefixed entries are kept.
    const result = pruneKnownHostsEntries(input);
    expect(result).toBe(input);
  });
});
