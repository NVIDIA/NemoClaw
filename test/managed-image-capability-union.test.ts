// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectManagedImageHermesUvPackages,
  collectManagedImageOpenClawPluginInstallSpecs,
  installManagedImageCapabilityUnion,
} from "../src/lib/messaging/applier/build/messaging-build-applier.mts";

describe("managed-image capability union", () => {
  it("derives the complete all-agent package union from trusted manifests (#7744)", () => {
    expect(collectManagedImageOpenClawPluginInstallSpecs({ OPENCLAW_VERSION: "2026.7.1" })).toEqual(
      [
        "npm:@openclaw/discord@2026.7.1",
        "npm:@tencent-weixin/openclaw-weixin@2.4.3",
        "npm:@openclaw/slack@2026.7.1",
        "npm:@openclaw/whatsapp@2026.7.1",
        "npm:@openclaw/msteams@2026.7.1",
        "npm:@openclaw/googlechat@2026.7.1",
      ],
    );
    expect(collectManagedImageHermesUvPackages()).toEqual([
      "microsoft-teams-apps==2.0.13.4",
      "aiohttp==3.14.1",
    ]);
  });

  it("requires explicit neutral-image mode before installing the union (#7744)", () => {
    expect(() =>
      installManagedImageCapabilityUnion("hermes", {
        NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "0",
      }),
    ).toThrow(
      "Managed-image capability union installation requires NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1",
    );
  });

  it("installs the pinned Hermes union through its reviewed package boundary (#7744)", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-union-"));
    const trace = path.join(temporaryRoot, "uv.trace");
    fs.writeFileSync(
      path.join(temporaryRoot, "uv"),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$UV_TRACE"\n',
      { mode: 0o755 },
    );

    try {
      installManagedImageCapabilityUnion("hermes", {
        PATH: `${temporaryRoot}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        UV_TRACE: trace,
        NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION: "1",
      });
      expect(fs.readFileSync(trace, "utf8").trim()).toBe(
        "pip install --python /opt/hermes/.venv/bin/python --no-cache -- microsoft-teams-apps==2.0.13.4 aiohttp==3.14.1",
      );
    } finally {
      fs.rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });
});
