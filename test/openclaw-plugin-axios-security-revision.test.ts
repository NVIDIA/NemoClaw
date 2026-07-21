// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyReviewedInstallTarget,
  parseOpenClawPluginInstallInvocation,
  patchInstalledOpenClawPlugins,
  preparePluginInstallRollback,
  rollbackPluginInstall,
} from "../scripts/openclaw-plugin-axios-security-revision.mts";

const tempDirectories: string[] = [];

function writePackage(directory: string, manifest: object): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest));
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

  it.each([
    {
      args: ["--profile", "qa", "plugins", "install", "npm:@openclaw/slack@2026.6.10"],
      expectedStateSuffix: ".openclaw-qa",
      targetIndex: 4,
    },
    {
      args: ["plugins", "install", "npm:@openclaw/slack@2026.6.10", "--profile=qa"],
      expectedStateSuffix: ".openclaw-qa",
      targetIndex: 2,
    },
    {
      args: ["--dev", "plugins", "install", "npm:@openclaw/slack@2026.6.10"],
      expectedStateSuffix: ".openclaw-dev",
      targetIndex: 3,
    },
    {
      args: ["plugins", "install", "npm:@openclaw/slack@2026.6.10", "--dev"],
      expectedStateSuffix: ".openclaw-dev",
      targetIndex: 2,
    },
  ])("resolves the wrapper install target and state for $expectedStateSuffix", ({
    args,
    expectedStateSuffix,
    targetIndex,
  }) => {
    const homeDirectory = path.join(os.tmpdir(), "nemoclaw-wrapper-home");
    expect(parseOpenClawPluginInstallInvocation(args, { homeDirectory })).toEqual({
      stateDirectory: path.join(homeDirectory, expectedStateSuffix),
      targetIndex,
    });
  });

  it("gives an explicit state directory precedence over profile selection", () => {
    const stateDirectory = path.join(os.tmpdir(), "nemoclaw-custom-openclaw-state");
    expect(
      parseOpenClawPluginInstallInvocation(
        ["--profile", "qa", "plugins", "install", "npm:@openclaw/slack@2026.6.10"],
        { homeDirectory: os.tmpdir(), stateDirectory },
      ),
    ).toEqual({ stateDirectory, targetIndex: 4 });
  });

  it("does not enter remediation for commands other than plugins install", () => {
    expect(
      parseOpenClawPluginInstallInvocation(["plugins", "inspect", "slack"], {
        homeDirectory: os.tmpdir(),
      }),
    ).toBeNull();
  });

  it("removes a fresh reviewed plugin when post-install remediation fails", () => {
    const target = fixture();
    const savedPlugin = path.join(path.dirname(target.homeDirectory), "fresh-plugin");
    fs.renameSync(target.pluginRoot, savedPlugin);
    const manifestPath = preparePluginInstallRollback({
      stateDirectory: path.join(target.homeDirectory, ".openclaw"),
      workingDirectory: path.dirname(target.homeDirectory),
    });
    fs.mkdirSync(path.dirname(target.pluginRoot), { recursive: true });
    fs.renameSync(savedPlugin, target.pluginRoot);

    rollbackPluginInstall({
      manifestPath,
      stateDirectory: path.join(target.homeDirectory, ".openclaw"),
    });

    expect(fs.existsSync(target.pluginRoot)).toBe(false);
  });

  it("restores a pre-install reviewed plugin after remediation failure", () => {
    const target = fixture();
    const manifestPath = preparePluginInstallRollback({
      stateDirectory: path.join(target.homeDirectory, ".openclaw"),
      workingDirectory: path.dirname(target.homeDirectory),
    });
    fs.writeFileSync(path.join(target.pluginRoot, "package.json"), "{}\n");
    fs.rmSync(path.join(target.pluginRoot, "node_modules", "axios"), {
      recursive: true,
      force: true,
    });

    rollbackPluginInstall({
      manifestPath,
      stateDirectory: path.join(target.homeDirectory, ".openclaw"),
    });

    expect(
      JSON.parse(fs.readFileSync(path.join(target.pluginRoot, "package.json"), "utf8")),
    ).toMatchObject({ name: "@openclaw/slack", version: "2026.6.10" });
    expect(
      fs.readFileSync(
        path.join(target.pluginRoot, "node_modules", "axios", "vulnerable.js"),
        "utf8",
      ),
    ).toBe("old\n");
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
});
