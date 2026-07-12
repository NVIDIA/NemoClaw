// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "../..");
const pluginRoot = path.join(repoRoot, "nemoclaw");

type Release = readonly [year: number, month: number, day: number];

type PluginPackage = {
  openclaw?: {
    extensions?: unknown;
    compat?: {
      pluginApi?: unknown;
      minGatewayVersion?: unknown;
    };
    build?: {
      openclawVersion?: unknown;
    };
  };
};

function readPluginPackage(): PluginPackage {
  const result = spawnSync("npm", ["--prefix", pluginRoot, "pkg", "get", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`npm could not read the plugin metadata: ${result.stdout}${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function parseRelease(value: unknown, label: string): Release {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a release string`);
  }
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(value);
  if (!match) {
    throw new Error(`${label} must use the YYYY.M.D release format`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareRelease(left: Release, right: Release): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

describe("packed NemoClaw plugin metadata", () => {
  it("ships an importable extension whose build satisfies the advertised host bounds", async () => {
    const packageJson = readPluginPackage();
    const extensions = packageJson.openclaw?.extensions;
    expect(extensions).toEqual([expect.stringMatching(/^\.\/dist\/.+\.js$/)]);
    if (!Array.isArray(extensions) || typeof extensions[0] !== "string") {
      throw new Error("openclaw.extensions must declare one compiled entry");
    }

    const extensionPath = path.join(pluginRoot, extensions[0]);
    expect(fs.existsSync(extensionPath), "Run the plugin build before package contracts.").toBe(
      true,
    );
    const pluginModule = await import(pathToFileURL(extensionPath).href);
    expect(pluginModule.default).toBeTypeOf("function");

    const pluginApi = packageJson.openclaw?.compat?.pluginApi;
    if (typeof pluginApi !== "string" || !pluginApi.startsWith(">=")) {
      throw new Error("openclaw.compat.pluginApi must declare a minimum release");
    }
    const pluginApiMinimum = parseRelease(pluginApi.slice(2), "plugin API minimum");
    const gatewayMinimum = parseRelease(
      packageJson.openclaw?.compat?.minGatewayVersion,
      "gateway minimum",
    );
    const buildVersion = parseRelease(
      packageJson.openclaw?.build?.openclawVersion,
      "OpenClaw build version",
    );

    expect(pluginApiMinimum).toEqual(gatewayMinimum);
    expect(compareRelease(buildVersion, pluginApiMinimum)).toBeGreaterThanOrEqual(0);
    expect(compareRelease(buildVersion, gatewayMinimum)).toBeGreaterThanOrEqual(0);
  });

  it("includes every declared extension in the npm package", () => {
    const packageJson = readPluginPackage();
    const extensions = packageJson.openclaw?.extensions;
    if (!Array.isArray(extensions) || extensions.some((entry) => typeof entry !== "string")) {
      throw new Error("openclaw.extensions must be a string array");
    }

    const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: pluginRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(packed.status, `${packed.stdout}${packed.stderr}`).toBe(0);
    const report = JSON.parse(packed.stdout) as Array<{ files?: Array<{ path?: string }> }>;
    const packedPaths = new Set((report[0]?.files ?? []).map((entry) => entry.path));

    expect(packedPaths).toContain("openclaw.plugin.json");
    for (const extension of extensions) {
      expect(packedPaths).toContain(extension.replace(/^\.\//, ""));
    }
  });
});
