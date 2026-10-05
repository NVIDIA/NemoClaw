// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  managedPublisher,
  readWorkflow,
  repoRoot,
  required,
  step,
} from "../../helpers/managed-image-publication-workflow";

describe("managed OpenClaw neutral plugin validation", () => {
  let fixtureRoot: string;
  let configRoot: string;
  let configPath: string;
  let projectsRoot: string;
  let validator: string;
  let config: { plugins: { entries: Record<string, { enabled?: boolean }> } };
  let tavilyRoot: string;
  let manifestPath: string;
  let manifest: string;

  beforeEach(() => {
    const validation = required(
      step(
        managedPublisher(readWorkflow("managed-images.yaml")),
        "Validate exact managed image before promotion",
      ).run,
      "managed image validation is missing",
    );
    validator = required(
      validation.match(
        /node <<'VALIDATE_OPENCLAW_UNION'\n([\s\S]+?)\nVALIDATE_OPENCLAW_UNION/u,
      )?.[1],
      "OpenClaw union validator is missing",
    );
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-neutral-tavily-"));
    const generated = spawnSync(process.execPath, ["scripts/generate-openclaw-config.mts"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: fixtureRoot,
        NEMOCLAW_MODEL: "test-model",
        NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
      },
    });
    expect(generated.status, generated.stderr).toBe(0);
    configRoot = path.join(fixtureRoot, ".openclaw");
    configPath = path.join(configRoot, "openclaw.json");
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const version = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "agents/openclaw/openclaw-runtime/package.json"), "utf8"),
    ).dependencies.openclaw;
    projectsRoot = path.join(configRoot, "npm/projects");
    const packages = [
      "diagnostics-otel",
      "brave-plugin",
      "tavily-plugin",
      "discord",
      "slack",
      "whatsapp",
      "msteams",
      "googlechat",
    ];
    for (const name of packages) {
      const root = path.join(projectsRoot, name, "node_modules/@openclaw", name);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ name: `@openclaw/${name}`, version }),
      );
    }
    const weixinRoot = path.join(
      projectsRoot,
      "weixin/node_modules/@tencent-weixin/openclaw-weixin",
    );
    fs.mkdirSync(weixinRoot, { recursive: true });
    fs.writeFileSync(
      path.join(weixinRoot, "package.json"),
      JSON.stringify({ name: "@tencent-weixin/openclaw-weixin", version: "2.4.9" }),
    );

    tavilyRoot = path.join(projectsRoot, "tavily-plugin/node_modules/@openclaw/tavily-plugin");
    manifestPath = path.join(tavilyRoot, "package.json");
    manifest = fs.readFileSync(manifestPath, "utf8");
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function run() {
    return spawnSync(
      process.execPath,
      ["--input-type=commonjs", "-e", validator.replaceAll("/sandbox/.openclaw", configRoot)],
      { encoding: "utf8" },
    );
  }

  it("accepts the installed pinned Tavily package with generated neutral configuration", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    { name: "missing package", alter: () => fs.rmSync(manifestPath) },
    {
      name: "wrong package name",
      alter: () =>
        fs.writeFileSync(
          manifestPath,
          JSON.stringify({ ...JSON.parse(manifest), name: "wrong-package" }),
        ),
    },
    {
      name: "wrong package version",
      alter: () =>
        fs.writeFileSync(
          manifestPath,
          JSON.stringify({ ...JSON.parse(manifest), version: "0.0.0" }),
        ),
    },
    {
      name: "duplicate installation",
      alter: () => {
        const duplicateRoot = path.join(
          projectsRoot,
          "duplicate/node_modules/@openclaw/tavily-plugin",
        );
        fs.mkdirSync(duplicateRoot, { recursive: true });
        fs.writeFileSync(path.join(duplicateRoot, "package.json"), manifest);
      },
    },
    {
      name: "active plugin",
      alter: () => {
        config.plugins.entries.tavily = { enabled: true };
        fs.writeFileSync(configPath, JSON.stringify(config));
      },
    },
    {
      name: "missing enabled flag",
      alter: () => {
        config.plugins.entries.tavily = {};
        fs.writeFileSync(configPath, JSON.stringify(config));
      },
    },
    {
      name: "symlinked package root",
      alter: () => {
        const outside = path.join(fixtureRoot, "outside");
        fs.renameSync(tavilyRoot, outside);
        fs.symlinkSync(outside, tavilyRoot);
      },
    },
  ])("rejects Tavily with $name", ({ alter }) => {
    alter();
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "managed OpenClaw plugin tavily is missing, duplicated, or active",
    );
  });
});
