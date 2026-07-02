// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import policy from "../ci/reviewed-npm-lifecycle-allowlist.json";

describe("reviewed npm lifecycle policy", () => {
  it("keeps the exact archive and explicit-script allowlist", () => {
    expect(policy).toEqual({
      schemaVersion: 1,
      defaultPolicy: "deny",
      reviewedArchivePackages: [
        "@openclaw/brave-plugin@2026.6.9",
        "@openclaw/diagnostics-otel@2026.6.9",
        "@openclaw/discord@2026.6.9",
        "@openclaw/msteams@2026.6.9",
        "@openclaw/slack@2026.6.9",
        "@openclaw/whatsapp@2026.6.9",
        "@tencent-weixin/openclaw-weixin@2.4.3",
        "@zed-industries/codex-acp@0.11.1",
        "openclaw@2026.3.11",
        "openclaw@2026.4.24",
        "openclaw@2026.6.9",
      ],
      allowedLifecycleScripts: [
        {
          packageSpec: "openclaw@2026.4.24",
          event: "postinstall",
          manifestCommand: "node scripts/postinstall-bundled-plugins.mjs",
          explicitCommand:
            "node /usr/local/lib/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs",
        },
        {
          packageSpec: "openclaw@2026.6.9",
          event: "postinstall",
          manifestCommand: "node scripts/postinstall-bundled-plugins.mjs",
          explicitCommand:
            "node /usr/local/lib/node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs",
        },
      ],
    });
  });
});
