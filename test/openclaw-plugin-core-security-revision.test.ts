// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertReviewedOpenClawPluginTreeReport,
  classifyReviewedPluginCoreInstallTarget,
  patchInstalledOpenClawPluginCore,
  patchReviewedOpenClawPluginRoot,
  verifyRemediatedArchiveContents,
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
      const descriptor = fs.openSync(child, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const metadata = fs.fstatSync(descriptor);
        switch (true) {
          case metadata.isDirectory():
            snapshot.push({ mode: metadata.mode & 0o777, path: relative, type: "directory" });
            visit(child);
            break;
          case metadata.isFile():
            snapshot.push({
              contents: fs.readFileSync(descriptor).toString("base64"),
              mode: metadata.mode & 0o777,
              path: relative,
              type: "file",
            });
            break;
          default:
            snapshot.push({ path: relative, type: "other" });
        }
      } finally {
        fs.closeSync(descriptor);
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
    ["form-data", "form-data", "2.5.6", { hasown: "^2.0.4", "mime-types": "^2.1.35" }],
    ["qs", "qs", "6.15.3", { "side-channel": "^1.1.1" }],
    ["protobufjs-7", "protobufjs", "7.6.5", {}],
    ["protobufjs-8", "protobufjs", "8.7.1", {}],
    ["undici", "undici", "8.5.0", {}],
    ["ws", "ws", "8.21.1", {}],
  ] as const) {
    writePackage(path.join(replacements, key), {
      name,
      version,
      dependencies,
      license: "MIT",
      ...(key === "ws"
        ? {
            peerDependencies: {
              bufferutil: "^4.0.1",
              "utf-8-validate": ">=5.0.2",
            },
            peerDependenciesMeta: {
              bufferutil: { optional: true },
              "utf-8-validate": { optional: true },
            },
          }
        : {}),
    });
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
        express: "5.2.1",
        "form-data": version === "2026.6.10" ? "2.5.6" : "2.5.4",
        hasown: version === "2026.6.10" ? "2.0.4" : "2.0.3",
        "mime-types": "3.0.2",
        qs: "6.15.2",
        "side-channel": "1.1.0",
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
    const dependencyManifest = {
      name: dependency,
      version: observedVersion,
      ...(dependency === "express" ? { dependencies: { "content-type": "^1.0.5" } } : {}),
    };
    writePackage(path.join(pluginRoot, "node_modules", dependency), dependencyManifest);
    packages[`node_modules/${dependency}`] = dependencyManifest;
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

  it("preserves the remediated Slack ws optional peer metadata", () => {
    const target = pluginFixture("@openclaw/slack@2026.6.10");
    patchReviewedOpenClawPluginRoot(target.pluginRoot, target.replacements);
    const shrinkwrap = JSON.parse(
      fs.readFileSync(path.join(target.pluginRoot, "npm-shrinkwrap.json"), "utf8"),
    );
    expect(shrinkwrap.packages["node_modules/ws"].peerDependenciesMeta).toEqual({
      bufferutil: { optional: true },
      "utf-8-validate": { optional: true },
    });
  });

  it.each([
    ["@openclaw/slack@2026.5.22", "2.0.3"],
    ["@openclaw/msteams@2026.6.10", "2.0.4"],
  ] as const)("retains the reviewed HTTP compatibility graph for %s", (spec, hasownVersion) => {
    const target = pluginFixture(spec);
    patchReviewedOpenClawPluginRoot(target.pluginRoot, target.replacements);
    const readManifest = (name: string) =>
      JSON.parse(
        fs.readFileSync(path.join(target.pluginRoot, "node_modules", name, "package.json"), "utf8"),
      );
    expect(readManifest("form-data").dependencies).toMatchObject({
      hasown: hasownVersion,
      "mime-types": "3.0.2",
    });
    expect(readManifest("qs").dependencies["side-channel"]).toBe("1.1.0");
    expect(readManifest("express").dependencies["content-type"]).toBe("2.0.0");

    const shrinkwrap = JSON.parse(
      fs.readFileSync(path.join(target.pluginRoot, "npm-shrinkwrap.json"), "utf8"),
    );
    expect(shrinkwrap.packages["node_modules/form-data"].dependencies).toMatchObject({
      hasown: hasownVersion,
      "mime-types": "3.0.2",
    });
    expect(shrinkwrap.packages["node_modules/qs"].dependencies["side-channel"]).toBe("1.1.0");
    expect(shrinkwrap.packages["node_modules/express"].dependencies["content-type"]).toBe("2.0.0");
  });

  it("accepts only the exact reviewed post-remediation npm tree", () => {
    const target = pluginFixture("@openclaw/slack@2026.5.22");
    const problems = [
      "missing: @types/express@^5.0.0, required by @slack/bolt@4.7.2",
      `invalid: form-data@2.5.6 ${target.pluginRoot}/node_modules/form-data`,
    ];
    expect(() =>
      assertReviewedOpenClawPluginTreeReport({
        expectedSpec: "@openclaw/slack@2026.5.22",
        pluginRoot: target.pluginRoot,
        report: { problems },
        status: 1,
      }),
    ).not.toThrow();
    expect(() =>
      assertReviewedOpenClawPluginTreeReport({
        expectedSpec: "@openclaw/slack@2026.5.22",
        pluginRoot: target.pluginRoot,
        report: {
          problems: [
            ...problems,
            `invalid: side-channel@1.1.0 ${target.pluginRoot}/node_modules/side-channel`,
          ],
        },
        status: 1,
      }),
    ).toThrow("npm tree differs from the reviewed baseline");
  });

  it("accepts a reviewed plugin whose original and remediated trees are clean", () => {
    const target = pluginFixture("@openclaw/diagnostics-otel@2026.6.10");
    expect(() =>
      assertReviewedOpenClawPluginTreeReport({
        expectedSpec: "@openclaw/diagnostics-otel@2026.6.10",
        pluginRoot: target.pluginRoot,
        report: {},
        status: 0,
      }),
    ).not.toThrow();
  });

  it("classifies all reviewed plugin families and rejects unknown revisions", () => {
    expect(classifyReviewedPluginCoreInstallTarget("npm:@openclaw/whatsapp@2026.5.22")).toBe(
      "@openclaw/whatsapp@2026.5.22",
    );
    expect(classifyReviewedPluginCoreInstallTarget("npm:@openclaw/whatsapp@2026.7.1")).toBe("");
  });

  it("verifies packed plugin contents instead of unstable gzip bytes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-plugin-pack-contents-"));
    tempDirectories.push(root);
    const source = path.join(root, "source");
    const staging = path.join(root, "staging", "package");
    writePackage(source, { name: "packed-plugin", version: "1.0.0" });
    fs.writeFileSync(path.join(source, "payload.js"), "module.exports = true;\n");
    fs.cpSync(source, staging, { recursive: true });
    const archive = path.join(root, "packed-plugin.tgz");
    const packed = spawnSync("tar", ["-czf", archive, "-C", path.dirname(staging), "package"], {
      encoding: "utf8",
    });
    expect(packed.status, packed.stderr).toBe(0);
    expect(() => verifyRemediatedArchiveContents(source, archive)).not.toThrow();
    fs.writeFileSync(path.join(source, "payload.js"), "module.exports = false;\n");
    expect(() => verifyRemediatedArchiveContents(source, archive)).toThrow(
      "payload.js: contents changed during packing",
    );
    fs.writeFileSync(path.join(source, "payload.js"), "module.exports = true;\n");
    fs.writeFileSync(path.join(source, "development-only.txt"), "not packed\n");
    expect(() => verifyRemediatedArchiveContents(source, archive)).not.toThrow();

    const linkedArchive = path.join(root, "linked-plugin.tgz");
    fs.symlinkSync("payload.js", path.join(staging, "payload-link.js"));
    const linked = spawnSync(
      "tar",
      ["-czf", linkedArchive, "-C", path.dirname(staging), "package"],
      { encoding: "utf8" },
    );
    expect(linked.status, linked.stderr).toBe(0);
    expect(() => verifyRemediatedArchiveContents(source, linkedArchive)).toThrow(
      "archive has an unsafe member",
    );
  });

  it("rejects package metadata replaced by a symbolic link", () => {
    const target = pluginFixture("@openclaw/slack@2026.6.10");
    const manifest = path.join(target.pluginRoot, "package.json");
    const movedManifest = path.join(path.dirname(target.pluginRoot), "plugin-package.json");
    fs.renameSync(manifest, movedManifest);
    fs.symlinkSync(movedManifest, manifest);

    expect(() => patchReviewedOpenClawPluginRoot(target.pluginRoot, target.replacements)).toThrow();
  });

  it("rejects an intermediate candidate symlink before changing external plugin state", () => {
    const target = pluginFixture("@openclaw/slack@2026.6.10");
    const fixtureRoot = path.dirname(target.pluginRoot);
    const externalNodeModules = path.join(fixtureRoot, "external-node-modules");
    const externalPlugin = path.join(externalNodeModules, "@openclaw", "slack");
    fs.mkdirSync(path.dirname(externalPlugin), { recursive: true });
    fs.renameSync(target.pluginRoot, externalPlugin);
    const sentinel = path.join(externalPlugin, "external-sentinel.txt");
    fs.writeFileSync(sentinel, "must remain unchanged\n");

    const stateDirectory = path.join(fixtureRoot, "state");
    fs.mkdirSync(path.join(stateDirectory, "npm"), { recursive: true });
    fs.symlinkSync(externalNodeModules, path.join(stateDirectory, "npm", "node_modules"), "dir");

    expect(() =>
      patchInstalledOpenClawPluginCore({
        expectedPackageSpec: "@openclaw/slack@2026.6.10",
        replacementRoot: target.replacements,
        stateDirectory,
      }),
    ).toThrow("contains a symbolic link");
    expect(fs.readFileSync(sentinel, "utf8")).toBe("must remain unchanged\n");
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(externalPlugin, "node_modules", "body-parser", "package.json"),
          "utf8",
        ),
      ).version,
    ).toBe("2.2.2");
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

  it("fails closed before changing a plugin when replacement compatibility metadata drifts", () => {
    const target = pluginFixture("@openclaw/slack@2026.5.22");
    const before = treeSnapshot(target.pluginRoot);
    const replacementManifest = path.join(target.replacements, "form-data", "package.json");
    const replacement = JSON.parse(fs.readFileSync(replacementManifest, "utf8"));
    replacement.dependencies.hasown = "^2.1.0";
    fs.writeFileSync(replacementManifest, JSON.stringify(replacement));
    expect(() => patchReviewedOpenClawPluginRoot(target.pluginRoot, target.replacements)).toThrow(
      "form-data hasown dependency does not match the review",
    );
    expect(treeSnapshot(target.pluginRoot)).toEqual(before);
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
