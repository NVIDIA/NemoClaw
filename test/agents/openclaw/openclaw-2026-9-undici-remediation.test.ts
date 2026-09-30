// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  patchOpenClaw2026_9_1BundledUndiciGraph,
  patchOpenClaw2026_9_1RootUndiciGraph,
  remediateInstalledOpenClawPluginPackage,
  replaceInstalledOpenClaw2026_9_1BundledUndici,
} from "../../../scripts/lib/openclaw-npm-remediation.mts";

const roots: string[] = [];

const pluginFixtureContracts = {
  "@openclaw/discord@2026.9.1": {
    dependencies: {
      "@discord/embedded-app-sdk": "2.5.0",
      "@discordjs/voice": "0.19.2",
      "discord-api-types": "0.38.53",
      "libopus-wasm": "0.2.0",
      "mdast-util-from-markdown": "2.0.3",
      typebox: "1.3.17",
      undici: "8.10.0",
      ws: "8.21.3",
      zod: "4.4.3",
    },
    engine: ">=22.19.0",
    initialUndiciVersion: "8.10.0",
  },
  "@openclaw/slack@2026.9.1": {
    dependencies: {
      "@slack/bolt": "5.0.0",
      "@slack/socket-mode": "3.0.0",
      "@slack/types": "3.0.0",
      "@slack/web-api": "8.0.0",
      "get-east-asian-width": "1.6.0",
      typebox: "1.3.17",
      undici: "7.29.0",
      ws: "8.21.3",
      zod: "4.4.3",
    },
    engine: ">=20.18.1",
    initialUndiciVersion: "7.29.0",
  },
} as const;

type PluginSpec = keyof typeof pluginFixtureContracts;

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function pluginDependencies(packageSpec: PluginSpec): Record<string, string> {
  const contract = pluginFixtureContracts[packageSpec];
  return { ...contract.dependencies, undici: contract.initialUndiciVersion };
}

function writePluginFixture(packageSpec: PluginSpec): string {
  const directory = temporaryDirectory("nemoclaw-openclaw-undici-remediation-");
  const versionAt = packageSpec.lastIndexOf("@");
  const name = packageSpec.slice(0, versionAt);
  const contract = pluginFixtureContracts[packageSpec];
  const dependencies = pluginDependencies(packageSpec);
  writeJson(path.join(directory, "package.json"), {
    name,
    version: "2026.9.1",
    dependencies,
    bundledDependencies: Object.keys(dependencies),
  });
  writeJson(path.join(directory, "node_modules", "undici", "package.json"), {
    name: "undici",
    version: contract.initialUndiciVersion,
    engines: { node: contract.engine },
  });
  return directory;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("OpenClaw 2026.9.1 Undici remediation", () => {
  it("updates the reviewed root OpenClaw dependency exactly once", () => {
    const directory = temporaryDirectory("nemoclaw-openclaw-root-undici-remediation-");
    writeJson(path.join(directory, "package.json"), {
      name: "openclaw",
      version: "2026.9.1",
      dependencies: { chalk: "5.6.2", undici: "8.10.0" },
    });

    patchOpenClaw2026_9_1RootUndiciGraph(directory);

    expect(() => patchOpenClaw2026_9_1RootUndiciGraph(directory)).toThrow(
      "Undici dependency changed after review",
    );
  });

  it("rejects root OpenClaw dependency drift", () => {
    const directory = temporaryDirectory("nemoclaw-openclaw-root-undici-remediation-");
    writeJson(path.join(directory, "package.json"), {
      name: "openclaw",
      version: "2026.9.1",
      dependencies: { undici: "8.10.1" },
    });

    expect(() => patchOpenClaw2026_9_1RootUndiciGraph(directory)).toThrow(
      "Undici dependency changed after review",
    );
  });

  it.each([
    ["@openclaw/discord@2026.9.1", "8.10.2"],
    ["@openclaw/slack@2026.9.1", "7.29.1"],
  ] as const)(
    "updates the reviewed bundled Undici declaration for %s",
    (packageSpec, patchedVersion) => {
      const directory = writePluginFixture(packageSpec);

      const replacement = patchOpenClaw2026_9_1BundledUndiciGraph(directory, packageSpec);

      expect(replacement.version).toBe(patchedVersion);
      expect(() => patchOpenClaw2026_9_1BundledUndiciGraph(directory, packageSpec)).toThrow(
        "dependency graph changed",
      );
    },
  );

  it.each([
    ["@openclaw/discord@2026.9.1", "8.10.2", ">=22.19.0"],
    ["@openclaw/slack@2026.9.1", "7.29.1", ">=20.18.1"],
  ] as const)(
    "replaces the installed bundled Undici tree for %s",
    (packageSpec, patchedVersion, engine) => {
      const directory = writePluginFixture(packageSpec);
      const replacement = temporaryDirectory("nemoclaw-undici-replacement-");
      writeJson(path.join(replacement, "package.json"), {
        name: "undici",
        version: patchedVersion,
        engines: { node: engine },
      });
      fs.writeFileSync(path.join(replacement, "index.js"), "module.exports = {};\n");

      expect(() =>
        replaceInstalledOpenClaw2026_9_1BundledUndici(directory, packageSpec, replacement),
      ).not.toThrow();
      expect(() =>
        replaceInstalledOpenClaw2026_9_1BundledUndici(directory, packageSpec, replacement),
      ).toThrow("dependency graph changed");
    },
  );

  it("rejects a changed bundled dependency graph", () => {
    const packageSpec = "@openclaw/discord@2026.9.1";
    const directory = writePluginFixture(packageSpec);
    const manifestPath = path.join(directory, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.dependencies.undici = "8.10.1";
    writeJson(manifestPath, manifest);

    expect(() => patchOpenClaw2026_9_1BundledUndiciGraph(directory, packageSpec)).toThrow(
      "dependency graph changed",
    );
  });

  it("rejects an installed plugin reached through a symbolic link before fetching replacements", () => {
    const root = temporaryDirectory("nemoclaw-openclaw-installed-undici-remediation-");
    const packageDirectory = writePluginFixture("@openclaw/discord@2026.9.1");
    const linkedDirectory = path.join(root, "discord");
    fs.symlinkSync(packageDirectory, linkedDirectory);

    expect(() =>
      remediateInstalledOpenClawPluginPackage({
        packageDirectory: linkedDirectory,
        packageSpec: "@openclaw/discord@2026.9.1",
        workingDirectory: root,
      }),
    ).toThrow("must be a real directory without symbolic links");
  });
});
