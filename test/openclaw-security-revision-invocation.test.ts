// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  isHistoricalNemoClawInstallTarget,
  parseOpenClawPluginInstallInvocation,
  validateOpenClawStateDirectory,
} from "../scripts/openclaw-security-revision-invocation.mts";

const environment = { HOME: "/home/sandbox" };

describe("historical OpenClaw security revision invocation", () => {
  it.each([
    {
      args: ["plugins", "install", "/opt/nemoclaw"],
      stateDirectory: "/home/sandbox/.openclaw",
      targetIndex: 2,
    },
    {
      args: ["--profile", "qa", "plugins", "install", "/opt/nemoclaw"],
      stateDirectory: "/home/sandbox/.openclaw-qa",
      targetIndex: 4,
    },
    {
      args: ["plugins", "--profile=qa", "install", "/opt/nemoclaw"],
      stateDirectory: "/home/sandbox/.openclaw-qa",
      targetIndex: 3,
    },
    {
      args: ["plugins", "install", "/opt/nemoclaw", "--dev"],
      stateDirectory: "/home/sandbox/.openclaw-dev",
      targetIndex: 2,
    },
  ])("mirrors profile selection for $args", ({ args, stateDirectory, targetIndex }) => {
    expect(parseOpenClawPluginInstallInvocation({ args, environment })).toEqual({
      stateDirectory,
      target: "/opt/nemoclaw",
      targetIndex,
    });
  });

  it("lets an explicit state directory override CLI and environment profiles", () => {
    expect(
      parseOpenClawPluginInstallInvocation({
        args: ["--profile", "qa", "plugins", "install", "@openclaw/slack@2026.5.27"],
        environment: {
          HOME: "/home/sandbox",
          OPENCLAW_PROFILE: "ignored",
          OPENCLAW_STATE_DIR: "./state",
        },
        workingDirectory: "/workspace",
      }),
    ).toEqual({
      stateDirectory: "/workspace/state",
      target: "@openclaw/slack@2026.5.27",
      targetIndex: 4,
    });
  });

  it("expands a home-relative state directory", () => {
    expect(
      parseOpenClawPluginInstallInvocation({
        args: ["plugins", "install", "/opt/nemoclaw"],
        environment: { HOME: "/home/sandbox", OPENCLAW_STATE_DIR: "~/state" },
      })?.stateDirectory,
    ).toBe("/home/sandbox/state");
  });

  it("uses OPENCLAW_PROFILE when the CLI has no profile selector", () => {
    expect(
      parseOpenClawPluginInstallInvocation({
        args: ["plugins", "install", "/opt/nemoclaw"],
        environment: { HOME: "/home/sandbox", OPENCLAW_PROFILE: "qa" },
      })?.stateDirectory,
    ).toBe("/home/sandbox/.openclaw-qa");
  });

  it("accepts only an owned direct child of the trusted sandbox root", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-root-")));
    const state = path.join(root, ".openclaw");
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-outside-")),
    );
    const link = path.join(root, "linked-state");
    fs.mkdirSync(state);
    fs.symlinkSync(outside, link);
    try {
      expect(validateOpenClawStateDirectory({ stateDirectory: state, trustedRoot: root })).toBe(
        state,
      );
      expect(() =>
        validateOpenClawStateDirectory({
          stateDirectory: path.join(root, "new-profile"),
          trustedRoot: root,
        }),
      ).not.toThrow();
      expect(() =>
        validateOpenClawStateDirectory({ stateDirectory: root, trustedRoot: root }),
      ).toThrow(/direct child/u);
      expect(() =>
        validateOpenClawStateDirectory({ stateDirectory: outside, trustedRoot: root }),
      ).toThrow(/direct child/u);
      expect(() =>
        validateOpenClawStateDirectory({
          stateDirectory: path.join(root, ".openclaw", "nested"),
          trustedRoot: root,
        }),
      ).toThrow(/direct child/u);
      expect(() =>
        validateOpenClawStateDirectory({ stateDirectory: link, trustedRoot: root }),
      ).toThrow(/real directory/u);
      expect(() =>
        validateOpenClawStateDirectory({
          effectiveUid: fs.statSync(root).uid + 1,
          stateDirectory: state,
          trustedRoot: root,
        }),
      ).toThrow(/owned by the current user/u);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
      fs.rmSync(outside, { force: true, recursive: true });
    }
  });

  it.each([
    ["an option value is not a command", ["--label", "plugins", "install", "/opt/nemoclaw"]],
    ["the install target is absent", ["plugins", "install"]],
    ["the command follows the option terminator", ["--", "plugins", "install", "/opt/nemoclaw"]],
    [
      "--dev is combined with --profile",
      ["--dev", "--profile=dev", "plugins", "install", "/opt/nemoclaw"],
    ],
    ["the profile is invalid", ["--profile=../qa", "plugins", "install", "/opt/nemoclaw"]],
  ])("rejects an unreviewed invocation when %s", (_description, args) => {
    expect(parseOpenClawPluginInstallInvocation({ args, environment })).toBeNull();
  });

  it("matches only the canonical historical NemoClaw source directory", () => {
    expect(isHistoricalNemoClawInstallTarget("/opt/nemoclaw", "/workspace")).toBe(true);
    expect(isHistoricalNemoClawInstallTarget("../tmp/nemoclaw", "/workspace")).toBe(false);
    expect(isHistoricalNemoClawInstallTarget(".", path.join("/opt", "nemoclaw"))).toBe(true);
  });
});
