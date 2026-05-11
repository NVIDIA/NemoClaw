// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

describe("internal oclif namespace", () => {
  it("passes internal subcommands directly to oclif space-separated routing", () => {
    const result = spawnSync(process.execPath, [CLI, "internal", "dns", "fix-coredns", "--help"], {
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Internal: patch CoreDNS");
    expect(result.stdout).toContain("nemoclaw internal dns fix-coredns [gateway-name]");
  });

  it("exposes setup-proxy as an oclif-routed internal subcommand", () => {
    const result = spawnSync(process.execPath, [CLI, "internal", "dns", "setup-proxy", "--help"], {
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Internal: configure sandbox DNS proxy");
    expect(result.stdout).toContain("nemoclaw internal dns setup-proxy <gateway-name> <sandbox-name>");
  });

  it("exposes uninstall plan commands through oclif routing", () => {
    const result = spawnSync(process.execPath, [CLI, "internal", "uninstall", "run-plan", "--help"], {
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("NemoClaw Uninstaller");
    expect(result.stdout).toContain("--delete-models");
    expect(result.stdout).toContain("--keep-openshell");
    expect(result.stdout).toContain("--yes");
  });

  it("exposes the dev npm-link shim command through oclif routing", () => {
    const result = spawnSync(process.execPath, [CLI, "internal", "dev", "npm-link-or-shim", "--help"], {
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Internal: link the checkout CLI or create a dev shim");
    expect(result.stdout).toContain("nemoclaw internal dev npm-link-or-shim");
  });

  it("exposes installer plan commands through oclif routing", () => {
    const help = spawnSync(process.execPath, [CLI, "internal", "installer", "plan", "--help"], {
      encoding: "utf-8",
    });

    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Internal: build the NemoClaw installer plan");
    expect(help.stdout).toContain("nemoclaw internal installer plan [--json]");

    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "internal",
        "installer",
        "plan",
        "--json",
        "--install-ref",
        "v1.2.3",
        "--provider",
        "cloud",
        "--node-version",
        "v22.16.0",
        "--npm-version",
        "10.0.0",
      ],
      { encoding: "utf-8" },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      installRef: "v1.2.3",
      provider: { normalized: "build", raw: "cloud", valid: true },
      runtime: { ok: true },
    });
  });

  it("exposes installer ref and env normalization helpers through oclif routing", () => {
    const ref = spawnSync(
      process.execPath,
      [CLI, "internal", "installer", "resolve-release-tag", "--json", "--install-tag", "v2.0.0"],
      { encoding: "utf-8" },
    );
    const env = spawnSync(
      process.execPath,
      [CLI, "internal", "installer", "normalize-env", "--json", "--provider", "nim"],
      { encoding: "utf-8" },
    );

    expect(ref.status).toBe(0);
    expect(JSON.parse(ref.stdout)).toEqual({ installRef: "v2.0.0" });
    expect(env.status).toBe(0);
    expect(JSON.parse(env.stdout)).toMatchObject({
      installRef: "latest",
      provider: { normalized: "nim-local", raw: "nim", valid: true },
    });
  });
});
