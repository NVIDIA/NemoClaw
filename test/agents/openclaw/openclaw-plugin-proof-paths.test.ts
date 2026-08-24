// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";

const slackProof = fs.readFileSync(
  new URL("./e2e/lib/slack-api-proof.sh", import.meta.url),
  "utf8",
);
const discordProof = fs.readFileSync(
  new URL("./e2e/lib/discord-rest-policy-proof.sh", import.meta.url),
  "utf8",
);
const compact = (value: string): string => value.replaceAll(/\s+/g, "");

describe("OpenClaw installed-plugin proof discovery", () => {
  it("searches the runtime state directory for the Slack plugin", () => {
    expect(compact(slackProof)).toContain(
      'path.join(process.env.OPENCLAW_STATE_DIR||"/sandbox/.openclaw","extensions","slack")',
    );
  });

  it("searches the runtime state directory for the Discord plugin", () => {
    expect(compact(discordProof)).toContain(
      'path.join(process.env.OPENCLAW_STATE_DIR||"/sandbox/.openclaw","extensions","discord","dist","runtime-api.send.js"',
    );
  });
});
