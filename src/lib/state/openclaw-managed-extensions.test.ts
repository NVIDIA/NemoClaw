// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildRestoreCleanupCommand,
  buildRestoreTarArgs,
  isAllowedStateSymlink,
  OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS,
  shouldPreserveOpenClawManagedExtensions,
} from "./openclaw-managed-extensions";

const EXPECTED_MANAGED_EXTENSIONS = [
  "nemoclaw",
  "diagnostics-otel",
  "brave",
  "discord",
  "openclaw-weixin",
  "slack",
  "whatsapp",
  "msteams",
] as const;

describe("OpenClaw managed extension policy", () => {
  it("tracks every image-managed extension with a unique safe directory name", () => {
    expect(OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS).toEqual(EXPECTED_MANAGED_EXTENSIONS);
    expect(new Set(OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS).size).toBe(
      OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS.length,
    );
    expect(OPENCLAW_IMAGE_MANAGED_EXTENSION_DIRS).toSatisfy((names: readonly string[]) =>
      names.every((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)),
    );
  });

  it("preserves managed extensions only for an OpenClaw extension restore", () => {
    expect(
      shouldPreserveOpenClawManagedExtensions({ agentType: "openclaw" }, "/sandbox/custom-state", [
        "workspace",
        "extensions",
      ]),
    ).toBe(true);
    expect(
      shouldPreserveOpenClawManagedExtensions({ agentType: "custom" }, "/sandbox/.openclaw/", [
        "extensions",
      ]),
    ).toBe(true);
    expect(
      shouldPreserveOpenClawManagedExtensions({ agentType: "openclaw" }, "/sandbox/.openclaw", [
        "workspace",
      ]),
    ).toBe(false);
    expect(
      shouldPreserveOpenClawManagedExtensions({ agentType: "custom" }, "/sandbox/custom-state", [
        "extensions",
      ]),
    ).toBe(false);
  });

  it("excludes only image-managed extensions from the restore archive", () => {
    const args = buildRestoreTarArgs("/tmp/rebuild backup", ["workspace", "extensions"], true);

    expect(args.slice(0, 4)).toEqual(["-cf", "-", "-C", "/tmp/rebuild backup"]);
    expect(args.flatMap((arg, index) => (arg === "--exclude" ? [args[index + 1]] : []))).toEqual(
      EXPECTED_MANAGED_EXTENSIONS.map((name) => `extensions/${name}`),
    );
    expect(args.slice(-3)).toEqual(["--", "workspace", "extensions"]);
    expect(args).not.toContain("extensions/telegram");
  });

  it("leaves ordinary restore archives unfiltered", () => {
    expect(buildRestoreTarArgs("/tmp/backup", ["workspace", "extensions"], false)).toEqual([
      "-cf",
      "-",
      "-C",
      "/tmp/backup",
      "--",
      "workspace",
      "extensions",
    ]);
  });
});

describe("OpenClaw managed extension symlink policy", () => {
  it("allows exact image links and extension-local npm executable links", () => {
    expect(
      isAllowedStateSymlink(
        "extensions/openclaw-weixin/node_modules/.bin/qrcode-terminal",
        "../qrcode-terminal/bin/qrcode-terminal.js",
      ),
    ).toBe(true);
    expect(
      isAllowedStateSymlink(
        "extensions/slack/node_modules/openclaw",
        "/usr/local/lib/node_modules/openclaw",
      ),
    ).toBe(true);
    expect(
      isAllowedStateSymlink("extensions/nemoclaw/node_modules/.bin/json5", "../json5/lib/cli.js"),
    ).toBe(true);
  });

  it("rejects tampered, absolute, empty, and escaping npm link targets", () => {
    expect(
      isAllowedStateSymlink(
        "extensions/openclaw-weixin/node_modules/.bin/qrcode-terminal",
        "/etc/passwd",
      ),
    ).toBe(false);
    expect(isAllowedStateSymlink("extensions/slack/node_modules/openclaw", "/etc/passwd")).toBe(
      false,
    );
    expect(
      isAllowedStateSymlink("extensions/nemoclaw/node_modules/.bin/json5", "/usr/bin/json5"),
    ).toBe(false);
    expect(isAllowedStateSymlink("extensions/nemoclaw/node_modules/.bin/json5", "")).toBe(false);
    expect(
      isAllowedStateSymlink(
        "extensions/nemoclaw/node_modules/.bin/leak",
        "../../../../openclaw.json",
      ),
    ).toBe(false);
    expect(
      isAllowedStateSymlink("extensions/nemoclaw/node_modules/.bin/loop", "../.bin/other"),
    ).toBe(false);
  });

  it("rejects allowed targets outside the narrowly recognized source paths", () => {
    expect(
      isAllowedStateSymlink("workspace/openclaw", "/usr/local/lib/node_modules/openclaw"),
    ).toBe(false);
    expect(isAllowedStateSymlink("extensions/nemoclaw/bin/json5", "../json5/lib/cli.js")).toBe(
      false,
    );
  });

  it.each([
    ["extensions/../nemoclaw/node_modules/.bin/json5", "../json5/lib/cli.js"],
    ["extensions/nemoclaw/node_modules/.bin/../json5", "../json5/lib/cli.js"],
    ["extensions\\..\\slack\\node_modules\\openclaw", "/usr/local/lib/node_modules/openclaw"],
    ["extensions/nemoclaw/node_modules/.bin/json5", "../json5/../../../openclaw.json"],
    ["extensions/%2e%2e/node_modules/.bin/json5", "../json5/lib/cli.js"],
    ["extensions/nemoclaw/node_modules/.bin/json5", "%2e%2e/%2e%2e/etc/passwd"],
    ["extensions/nemoclaw/node_modules/.bin/json5", "/proc/self/exe"],
    ["extensions/nemoclaw/node_modules/.bin/json5", "/host/etc/passwd"],
  ])("rejects source and target traversal vectors: %s -> %s", (source, target) => {
    expect(isAllowedStateSymlink(source, target)).toBe(false);
  });
});

describe("OpenClaw managed extension cleanup", () => {
  it("removes ordinary state while preserving and validating managed extension directories", () => {
    const command = buildRestoreCleanupCommand(
      "/sandbox/.openclaw",
      ["workspace", "extensions"],
      true,
    );

    expect(command).toContain("rm -rf -- '/sandbox/.openclaw/workspace'");
    expect(command).not.toContain("rm -rf -- '/sandbox/.openclaw/extensions'");
    expect(command).toContain("mkdir -p -- '/sandbox/.openclaw/extensions'");
    for (const extensionName of EXPECTED_MANAGED_EXTENSIONS) {
      expect(command).toContain(`p='/sandbox/.openclaw/extensions/${extensionName}'`);
      expect(command).toContain(`! -name '${extensionName}'`);
    }
    expect(command).toContain('[ -e "$p" ] || [ -L "$p" ]');
    expect(command).toContain('[ ! -d "$p" ] || [ -L "$p" ]');
    expect(command).toContain("-exec rm -rf -- {} +");
  });

  it("executes cleanup without deleting managed directories and rejects dangling symlinks", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-extensions-"));
    const extensions = path.join(root, "extensions");
    const managed = path.join(extensions, "nemoclaw");
    const dangling = path.join(extensions, "brave");
    const userExtension = path.join(extensions, "user-extension");
    fs.mkdirSync(managed, { recursive: true });
    fs.mkdirSync(userExtension);
    fs.symlinkSync(path.join(root, "missing-target"), dangling);
    const command = buildRestoreCleanupCommand(root, ["extensions"], true);

    expect(() => execFileSync("bash", ["-c", command], { stdio: "pipe" })).toThrow();
    expect(fs.lstatSync(dangling).isSymbolicLink()).toBe(true);
    fs.unlinkSync(dangling);
    execFileSync("bash", ["-c", command], { stdio: "pipe" });

    expect(fs.statSync(managed).isDirectory()).toBe(true);
    expect(fs.existsSync(userExtension)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("removes complete state directories when managed preservation is disabled", () => {
    expect(
      buildRestoreCleanupCommand("/sandbox/.openclaw", ["workspace", "extensions"], false),
    ).toBe("rm -rf -- '/sandbox/.openclaw/workspace' && rm -rf -- '/sandbox/.openclaw/extensions'");
  });

  it("returns a no-op when no restore directories require cleanup", () => {
    expect(buildRestoreCleanupCommand("/sandbox/.openclaw", [], false)).toBe(":");
  });
});
