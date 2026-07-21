// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyReviewedPluginCoreInstallTarget,
  patchInstalledOpenClawPluginCore,
  patchReviewedOpenClawPluginRoot,
} from "../scripts/openclaw-plugin-core-security-revision.mts";

const tempDirectories: string[] = [];

function writePackage(directory: string, manifest: object): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
}

function treeSnapshot(directory: string): object[] {
  const snapshot: object[] = [];
  const visit = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const child = path.join(current, name);
      const relative = path.relative(directory, child);
      const metadata = fs.lstatSync(child);
      switch (true) {
        case metadata.isDirectory() && !metadata.isSymbolicLink():
          snapshot.push({ mode: metadata.mode & 0o777, path: relative, type: "directory" });
          visit(child);
          break;
        case metadata.isFile():
          snapshot.push({
            contents: fs.readFileSync(child).toString("base64"),
            mode: metadata.mode & 0o777,
            path: relative,
            type: "file",
          });
          break;
        case metadata.isSymbolicLink():
          snapshot.push({ path: relative, target: fs.readlinkSync(child), type: "symlink" });
          break;
        default:
          snapshot.push({ path: relative, type: "other" });
      }
    }
  };
  visit(directory);
  return snapshot;
}

function replacementFixture(root: string): string {
  const replacements = path.join(root, "replacements");
  for (const [key, name, version, dependencies] of [
    ["body-parser", "body-parser", "2.3.0", { "content-type": "^2.0.0", qs: "^6.15.0" }],
    ["content-type", "content-type", "2.0.0", {}],
    ["form-data", "form-data", "2.5.6", {}],
    ["qs", "qs", "6.15.3", {}],
    ["protobufjs-7", "protobufjs", "7.6.5", {}],
    ["protobufjs-8", "protobufjs", "8.7.1", {}],
    ["undici", "undici", "8.5.0", {}],
    ["ws", "ws", "8.21.1", {}],
  ] as const) {
    writePackage(path.join(replacements, key), { name, version, dependencies, license: "MIT" });
  }
  return replacements;
}

function pluginFixture(spec: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-plugin-core-revision-"));
  tempDirectories.push(root);
  const pluginRoot = path.join(root, "plugin");
  const [name, version] = spec.split(/@(?=\d)/);
  const isHttp = name === "@openclaw/slack" || name === "@openclaw/msteams";
  const dependencyVersions = isHttp
    ? {
        "body-parser": "2.2.2",
        "content-type": "1.0.5",
        "form-data": "2.5.4",
        qs: "6.15.2",
        ...(name === "@openclaw/slack" ? { ws: "8.21.0" } : {}),
      }
    : name === "@openclaw/discord"
      ? { undici: version === "2026.6.10" ? "8.5.0" : "8.3.0", ws: "8.21.0" }
      : {
          protobufjs: version === "2026.6.10" ? "7.6.3" : "8.4.0",
          ...(name === "@openclaw/whatsapp" && version === "2026.5.22" ? { ws: "8.20.1" } : {}),
        };
  writePackage(pluginRoot, {
    name,
    version,
    dependencies: { existing: "1.0.0" },
    bundledDependencies: ["existing"],
  });
  const packages: Record<string, object> = {
    "": { dependencies: { existing: "1.0.0" }, bundleDependencies: ["existing"] },
  };
  for (const [dependency, observedVersion] of Object.entries(dependencyVersions)) {
    writePackage(path.join(pluginRoot, "node_modules", dependency), {
      name: dependency,
      version: observedVersion,
    });
    packages[`node_modules/${dependency}`] = { version: observedVersion };
  }
  fs.writeFileSync(
    path.join(pluginRoot, "npm-shrinkwrap.json"),
    JSON.stringify({ lockfileVersion: 3, packages }),
  );
  return { pluginRoot, replacements: replacementFixture(root) };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("historical OpenClaw bundled plugin security revisions", () => {
  it.each([
    [
      "@openclaw/slack@2026.6.10",
      {
        "body-parser": "2.3.0",
        "content-type": "2.0.0",
        "form-data": "2.5.6",
        qs: "6.15.3",
        ws: "8.21.1",
      },
    ],
    ["@openclaw/discord@2026.5.22", { undici: "8.5.0", ws: "8.21.1" }],
    ["@openclaw/diagnostics-otel@2026.5.27", { protobufjs: "8.7.1" }],
    ["@openclaw/whatsapp@2026.5.22", { protobufjs: "8.7.1", ws: "8.21.1" }],
    ["@openclaw/whatsapp@2026.6.10", { protobufjs: "7.6.5" }],
  ] as const)("patches and synchronizes %s", (spec, expected) => {
    const target = pluginFixture(spec);
    expect(patchReviewedOpenClawPluginRoot(target.pluginRoot, target.replacements)).toBe(spec);
    const shrinkwrap = JSON.parse(
      fs.readFileSync(path.join(target.pluginRoot, "npm-shrinkwrap.json"), "utf8"),
    );
    for (const [name, version] of Object.entries(expected)) {
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(target.pluginRoot, "node_modules", name, "package.json"),
            "utf8",
          ),
        ).version,
      ).toBe(version);
      expect(shrinkwrap.packages[`node_modules/${name}`].version).toBe(version);
    }
  });

  it("classifies all reviewed plugin families and rejects unknown revisions", () => {
    expect(classifyReviewedPluginCoreInstallTarget("npm:@openclaw/whatsapp@2026.5.22")).toBe(
      "@openclaw/whatsapp@2026.5.22",
    );
    expect(classifyReviewedPluginCoreInstallTarget("npm:@openclaw/whatsapp@2026.7.1")).toBe("");
  });

  it("rejects package metadata replaced by a symbolic link", () => {
    const target = pluginFixture("@openclaw/slack@2026.6.10");
    const manifest = path.join(target.pluginRoot, "package.json");
    const movedManifest = path.join(path.dirname(target.pluginRoot), "plugin-package.json");
    fs.renameSync(manifest, movedManifest);
    fs.symlinkSync(movedManifest, manifest);

    expect(() => patchReviewedOpenClawPluginRoot(target.pluginRoot, target.replacements)).toThrow();
  });

  it("fails closed before replacing any drifted bundled dependency", () => {
    const target = pluginFixture("@openclaw/slack@2026.6.10");
    writePackage(path.join(target.pluginRoot, "node_modules", "qs"), {
      name: "qs",
      version: "6.13.0",
    });
    expect(() => patchReviewedOpenClawPluginRoot(target.pluginRoot, target.replacements)).toThrow(
      "unexpected installed qs",
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(target.pluginRoot, "node_modules", "body-parser", "package.json"),
          "utf8",
        ),
      ).version,
    ).toBe("2.2.2");
  });

  it("restores every dependency and metadata file after a mid-transaction failure", () => {
    const target = pluginFixture("@openclaw/slack@2026.6.10");
    const before = treeSnapshot(target.pluginRoot);
    expect(() =>
      patchReviewedOpenClawPluginRoot(target.pluginRoot, target.replacements, {
        injectFailure: (event) =>
          event.index === 0 && event.phase === "after-install"
            ? (() => {
                throw new Error("injected core-plugin transaction failure");
              })()
            : undefined,
      }),
    ).toThrow("injected core-plugin transaction failure");
    expect(treeSnapshot(target.pluginRoot)).toEqual(before);
  });

  it("rejects a symlinked extensions parent without modifying the external plugin", () => {
    const target = pluginFixture("@openclaw/slack@2026.6.10");
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-core-link-"));
    tempDirectories.push(stateDirectory);
    const externalExtensions = path.join(path.dirname(target.pluginRoot), "external-extensions");
    fs.mkdirSync(externalExtensions);
    const externalPlugin = path.join(externalExtensions, "slack");
    fs.renameSync(target.pluginRoot, externalPlugin);
    fs.symlinkSync(externalExtensions, path.join(stateDirectory, "extensions"));
    const before = treeSnapshot(externalPlugin);

    expect(() =>
      patchInstalledOpenClawPluginCore({
        expectedPackageSpec: "@openclaw/slack@2026.6.10",
        replacementRoot: target.replacements,
        stateDirectory,
      }),
    ).toThrow("contains a symbolic link");
    expect(treeSnapshot(externalPlugin)).toEqual(before);
  });

  it("rejects a symlinked projects parent without modifying the external plugin", () => {
    const target = pluginFixture("@openclaw/slack@2026.6.10");
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-project-link-"));
    tempDirectories.push(stateDirectory);
    const externalProjects = path.join(path.dirname(target.pluginRoot), "external-projects");
    const externalPlugin = path.join(
      externalProjects,
      "slack-project",
      "node_modules",
      "@openclaw",
      "slack",
    );
    fs.mkdirSync(path.dirname(externalPlugin), { recursive: true });
    fs.renameSync(target.pluginRoot, externalPlugin);
    fs.mkdirSync(path.join(stateDirectory, "npm"));
    fs.symlinkSync(externalProjects, path.join(stateDirectory, "npm", "projects"));
    const before = treeSnapshot(externalPlugin);

    expect(() =>
      patchInstalledOpenClawPluginCore({
        expectedPackageSpec: "@openclaw/slack@2026.6.10",
        replacementRoot: target.replacements,
        stateDirectory,
      }),
    ).toThrow("contains a symbolic link");
    expect(treeSnapshot(externalPlugin)).toEqual(before);
  });
});
