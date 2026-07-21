// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyReviewedInstallTarget,
  patchInstalledOpenClawPlugins,
  patchReviewedOpenClawPluginAxiosRoot,
} from "../scripts/openclaw-plugin-axios-security-revision.mts";

const tempDirectories: string[] = [];

function treeSnapshot(root: string): object[] {
  const entries: object[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const pathname = path.join(directory, name);
      const relativePath = path.relative(root, pathname);
      const metadata = fs.lstatSync(pathname);
      const snapshotDirectory = (): void => {
        entries.push({ mode: metadata.mode & 0o7777, path: relativePath, type: "directory" });
        visit(pathname);
      };
      const snapshotFile = (): void => {
        entries.push({
          bytes: fs.readFileSync(pathname).toString("base64"),
          mode: metadata.mode & 0o7777,
          path: relativePath,
          type: "file",
        });
      };
      const snapshotUnsafeEntry = (): void => {
        entries.push({ path: relativePath, type: "unsafe" });
      };
      (metadata.isDirectory()
        ? snapshotDirectory
        : metadata.isFile()
          ? snapshotFile
          : snapshotUnsafeEntry)();
    }
  };
  visit(root);
  return entries;
}

function writePackage(directory: string, manifest: object): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
}

function fail(message: string): never {
  throw new Error(message);
}

function fixture(layout: "extension" | "managed" | "project" = "project") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-axios-revision-"));
  tempDirectories.push(root);
  const homeDirectory = path.join(root, "home");
  const replacementRoot = path.join(root, "replacement");
  const pluginRoot =
    layout === "extension"
      ? path.join(homeDirectory, ".openclaw", "extensions", "slack")
      : layout === "managed"
        ? path.join(homeDirectory, ".openclaw", "npm", "node_modules", "@openclaw", "slack")
        : path.join(
            homeDirectory,
            ".openclaw",
            "npm",
            "projects",
            "openclaw-slack-reviewed",
            "node_modules",
            "@openclaw",
            "slack",
          );

  writePackage(replacementRoot, {
    name: "axios",
    version: "1.18.0",
    dependencies: { "https-proxy-agent": "^5.0.1" },
  });
  writePackage(path.join(replacementRoot, "node_modules", "https-proxy-agent"), {
    name: "https-proxy-agent",
    version: "5.0.1",
    dependencies: { "agent-base": "6", debug: "4" },
  });
  writePackage(
    path.join(replacementRoot, "node_modules", "https-proxy-agent", "node_modules", "agent-base"),
    { name: "agent-base", version: "6.0.2", dependencies: { debug: "4" } },
  );
  writePackage(pluginRoot, {
    name: "@openclaw/slack",
    version: "2026.6.10",
    dependencies: { "@slack/bolt": "4.7.2" },
    bundledDependencies: ["@slack/bolt"],
  });
  fs.writeFileSync(
    path.join(pluginRoot, "npm-shrinkwrap.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: { "@slack/bolt": "4.7.2" },
          bundleDependencies: ["@slack/bolt"],
        },
        "node_modules/axios": { version: "1.16.0", integrity: "vulnerable" },
      },
    }),
  );
  writePackage(path.join(pluginRoot, "node_modules", "axios"), {
    name: "axios",
    version: "1.16.0",
  });
  fs.writeFileSync(path.join(pluginRoot, "node_modules", "axios", "vulnerable.js"), "old\n");
  return { homeDirectory, pluginRoot, replacementRoot };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("historical OpenClaw plugin Axios security revisions", () => {
  it.each([
    "extension",
    "managed",
    "project",
  ] as const)("patches the reviewed %s install layout and synchronizes package metadata", (layout) => {
    const target = fixture(layout);
    expect(
      patchInstalledOpenClawPlugins({
        homeDirectory: target.homeDirectory,
        replacementRoot: target.replacementRoot,
        expectedPackageSpec: "@openclaw/slack@2026.6.10",
      }),
    ).toContain("@openclaw/slack@2026.6.10");

    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(target.pluginRoot, "node_modules", "axios", "package.json"),
          "utf8",
        ),
      ).version,
    ).toBe("1.18.0");
    expect(
      fs.existsSync(path.join(target.pluginRoot, "node_modules", "axios", "vulnerable.js")),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          target.pluginRoot,
          "node_modules",
          "axios",
          "node_modules",
          "https-proxy-agent",
          "node_modules",
          "agent-base",
          "package.json",
        ),
      ),
    ).toBe(true);
  });

  it("classifies only the exact reviewed historical npm specs", () => {
    expect(classifyReviewedInstallTarget("npm:@openclaw/slack@2026.5.27")).toBe(
      "@openclaw/slack@2026.5.27",
    );
    expect(classifyReviewedInstallTarget("npm:@openclaw/slack@2026.7.1")).toBe("");
    expect(classifyReviewedInstallTarget("/opt/nemoclaw")).toBe("");
  });

  it("patches a materialized reviewed archive root for build-time audit", () => {
    const target = fixture();
    expect(patchReviewedOpenClawPluginAxiosRoot(target.pluginRoot, target.replacementRoot)).toBe(
      "@openclaw/slack@2026.6.10",
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(target.pluginRoot, "node_modules", "axios", "package.json"),
          "utf8",
        ),
      ).version,
    ).toBe("1.18.0");
  });

  it("rejects package metadata replaced by a symbolic link", () => {
    const target = fixture();
    const manifest = path.join(target.pluginRoot, "package.json");
    const movedManifest = path.join(path.dirname(target.pluginRoot), "plugin-package.json");
    fs.renameSync(manifest, movedManifest);
    fs.symlinkSync(movedManifest, manifest);

    expect(() =>
      patchInstalledOpenClawPlugins({
        homeDirectory: target.homeDirectory,
        replacementRoot: target.replacementRoot,
        expectedPackageSpec: "@openclaw/slack@2026.6.10",
      }),
    ).toThrow();
  });

  it("fails closed if a reviewed install reports success without a reviewed layout", () => {
    const target = fixture();
    fs.rmSync(target.pluginRoot, { recursive: true, force: true });
    expect(() =>
      patchInstalledOpenClawPlugins({
        homeDirectory: target.homeDirectory,
        replacementRoot: target.replacementRoot,
        expectedPackageSpec: "@openclaw/slack@2026.6.10",
      }),
    ).toThrow("was not found in a reviewed install layout");
  });

  it("fails closed when the bundled vulnerable Axios layout has drifted", () => {
    const target = fixture();
    writePackage(path.join(target.pluginRoot, "node_modules", "axios"), {
      name: "axios",
      version: "1.17.0",
    });
    expect(() =>
      patchInstalledOpenClawPlugins({
        homeDirectory: target.homeDirectory,
        replacementRoot: target.replacementRoot,
      }),
    ).toThrow("unexpected installed Axios");
  });

  it("patches candidates under an explicit OpenClaw state directory", () => {
    const target = fixture();
    expect(
      patchInstalledOpenClawPlugins({
        stateDirectory: path.join(target.homeDirectory, ".openclaw"),
        replacementRoot: target.replacementRoot,
        expectedPackageSpec: "@openclaw/slack@2026.6.10",
      }),
    ).toContain("@openclaw/slack@2026.6.10");
  });

  it("restores the Axios tree and package metadata when metadata commit fails", () => {
    const target = fixture();
    const before = treeSnapshot(target.homeDirectory);
    expect(() =>
      patchInstalledOpenClawPlugins({
        homeDirectory: target.homeDirectory,
        replacementRoot: target.replacementRoot,
        transactionHook: (event) =>
          event.phase === "after-install" &&
          event.label === "@openclaw/slack@2026.6.10 package metadata"
            ? fail("injected plugin metadata commit failure")
            : undefined,
      }),
    ).toThrow("injected plugin metadata commit failure");
    expect(treeSnapshot(target.homeDirectory)).toEqual(before);
  });

  it("restores the Axios tree and package metadata when final verification fails", () => {
    const target = fixture();
    const before = treeSnapshot(target.homeDirectory);
    expect(() =>
      patchInstalledOpenClawPlugins({
        homeDirectory: target.homeDirectory,
        replacementRoot: target.replacementRoot,
        transactionHook: (event) =>
          event.phase === "before-verify"
            ? fail("injected plugin verification failure")
            : undefined,
      }),
    ).toThrow("injected plugin verification failure");
    expect(treeSnapshot(target.homeDirectory)).toEqual(before);
  });
});
