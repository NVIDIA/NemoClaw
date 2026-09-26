// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  expectedWechatGraph,
  verifyOpenClawPeerCompatibility,
  verifyWechatRuntimeLock,
} from "../../scripts/verify-wechat-runtime-lock.mts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const packages = {
  "node_modules/@tencent-weixin/openclaw-weixin": {
    version: "2.4.3",
    integrity: "sha512-plugin",
    dependencies: { "qrcode-terminal": "0.12.0", zod: "^4.3.6" },
    peerDependencies: { openclaw: ">=2026.3.22" },
  },
  "node_modules/qrcode-terminal": { version: "0.12.0", integrity: "sha512-qr" },
  "node_modules/zod": { version: "4.4.3", integrity: "sha512-zod" },
};

function writePackage(
  root: string,
  location: string,
  record: { version: string; peerDependencies?: Record<string, string> },
): void {
  const target = path.join(root, location);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, "package.json"),
    JSON.stringify({
      type: "module",
      version: record.version,
      peerDependencies: record.peerDependencies,
    }),
  );
}

function fixture(sdkPath = "channel-message"): {
  lockFile: string;
  projectsRoot: string;
  installedLock: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-lock-"));
  tempDirs.push(root);
  const projectsRoot = path.join(root, "projects");
  const installedRoot = path.join(projectsRoot, "wechat-project");
  fs.mkdirSync(installedRoot, { recursive: true });
  for (const [location, record] of Object.entries(packages)) {
    writePackage(installedRoot, location, record);
  }
  const pluginRoot = path.join(installedRoot, "node_modules/@tencent-weixin/openclaw-weixin");
  const handlerDir = path.join(pluginRoot, "dist/src/messaging");
  const peerRoot = path.join(pluginRoot, "node_modules/openclaw");
  fs.mkdirSync(handlerDir, { recursive: true });
  fs.mkdirSync(peerRoot, { recursive: true });
  fs.writeFileSync(
    path.join(peerRoot, "package.json"),
    JSON.stringify({
      type: "module",
      exports: { "./plugin-sdk/channel-message": "./channel-message.js" },
    }),
  );
  fs.writeFileSync(
    path.join(peerRoot, "channel-message.js"),
    "export function createTypingCallbacks() {}\n",
  );
  fs.writeFileSync(
    path.join(handlerDir, "process-message.js"),
    `import { createTypingCallbacks } from "openclaw/plugin-sdk/${sdkPath}";\nexport { createTypingCallbacks };\n`,
  );
  const lockFile = path.join(root, "reviewed-lock.json");
  const installedLock = path.join(installedRoot, "package-lock.json");
  fs.writeFileSync(lockFile, JSON.stringify({ packages }));
  fs.writeFileSync(installedLock, JSON.stringify({ packages }));
  return { lockFile, projectsRoot, installedLock };
}

describe("WeChat runtime dependency lock", () => {
  it("derives the reviewed graph from lock metadata", () => {
    expect([...expectedWechatGraph({ packages }).keys()]).toEqual(Object.keys(packages));
  });

  it("loads the inbound handler after verifying the installed graph and peer range", async () => {
    const { lockFile, projectsRoot } = fixture();
    await expect(
      verifyWechatRuntimeLock(lockFile, projectsRoot, "2026.6.10"),
    ).resolves.toBeUndefined();
  });

  it("rejects a removed SDK import even when the peer range is satisfied (#12288)", async () => {
    const { lockFile, projectsRoot } = fixture("channel-runtime");
    await expect(verifyWechatRuntimeLock(lockFile, projectsRoot, "2026.9.1")).rejects.toThrow(
      /channel-runtime/,
    );
  });

  it("rejects an OpenClaw runtime below the locked plugin peer minimum", () => {
    expect(() => verifyOpenClawPeerCompatibility("2026.3.22", ">=2026.3.22")).not.toThrow();
    expect(() => verifyOpenClawPeerCompatibility("2026.6.10", ">=2026.3.22")).not.toThrow();
    expect(() => verifyOpenClawPeerCompatibility("2026.3.21", ">=2026.3.22")).toThrow(
      /does not satisfy WeChat peer dependency/,
    );
    expect(() => verifyOpenClawPeerCompatibility("2026.6.10", "^2026.3.22")).toThrow(
      /unsupported WeChat OpenClaw peer range/,
    );
  });

  it("rejects lock metadata drift and an unreviewed package", async () => {
    const metadataDrift = fixture();
    const driftedPackages = structuredClone(packages);
    driftedPackages["node_modules/zod"].integrity = "sha512-drift";
    fs.writeFileSync(metadataDrift.installedLock, JSON.stringify({ packages: driftedPackages }));
    await expect(
      verifyWechatRuntimeLock(metadataDrift.lockFile, metadataDrift.projectsRoot, "2026.6.10"),
    ).rejects.toThrow(/metadata does not match/);

    const extraPackage = fixture();
    fs.writeFileSync(
      extraPackage.installedLock,
      JSON.stringify({
        packages: { ...packages, "node_modules/unreviewed": { version: "1.0.0" } },
      }),
    );
    await expect(
      verifyWechatRuntimeLock(extraPackage.lockFile, extraPackage.projectsRoot, "2026.6.10"),
    ).rejects.toThrow(/dependency set does not match/);
  });
});
