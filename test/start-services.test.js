// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const START_SERVICES = path.join(import.meta.dirname, "..", "scripts", "start-services.sh");

describe("start-services", () => {
  it("tracks Discord bridge in status and stop flows", () => {
    const src = fs.readFileSync(START_SERVICES, "utf-8");

    expect(src).toMatch(/for svc in telegram-bridge discord-bridge cloudflared;/);
    expect(src).toMatch(/stop_service discord-bridge/);
  });

  it("requires DISCORD_CHANNEL_ID when DISCORD_BOT_TOKEN is set", () => {
    const src = fs.readFileSync(START_SERVICES, "utf-8");

    expect(src).toMatch(/DISCORD_CHANNEL_ID required when DISCORD_BOT_TOKEN is set/);
  });

  it("starts the Discord bridge when DISCORD_BOT_TOKEN is configured", () => {
    const src = fs.readFileSync(START_SERVICES, "utf-8");

    expect(src).toMatch(/start_service discord-bridge/);
    expect(src).toMatch(/node "\$REPO_DIR\/scripts\/discord-bridge\.js"/);
  });

  it("shows Discord bridge status in the services banner", () => {
    const src = fs.readFileSync(START_SERVICES, "utf-8");

    expect(src).toMatch(/Discord:\s+bridge running/);
    expect(src).toMatch(/Discord:\s+not started/);
  });
});
