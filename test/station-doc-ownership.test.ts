// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const STATION_PREPARE = path.join(REPO_ROOT, "scripts", "prepare-dgx-station-host.sh");
const STATION_PREREQUISITES = path.join(REPO_ROOT, "docs", "get-started", "prerequisites.mdx");
const STATION_QUICKSTART = path.join(REPO_ROOT, "docs", "get-started", "quickstart.mdx");

describe("DGX Station documentation ownership", () => {
  it("keeps Station prerequisites canonical and links to them from quickstart", () => {
    const helper = fs.readFileSync(STATION_PREPARE, "utf-8");
    const prerequisites = fs.readFileSync(STATION_PREREQUISITES, "utf-8");
    const quickstart = fs.readFileSync(STATION_QUICKSTART, "utf-8");
    const pinnedValues = [
      "DRIVER_VERSION",
      "DOCKER_VERSION",
      "TOOLKIT_VERSION",
      "FACTORY_DKMS_VERSION",
      "TARGET_DKMS_VERSION",
    ].map((name) => {
      const value = helper.match(new RegExp(`readonly ${name}="([^"]+)"`))?.[1];
      expect(value, `${name} must remain declared in the Station helper`).toBeTruthy();
      return value as string;
    });

    for (const version of pinnedValues) expect(prerequisites).toContain(version);
    expect(prerequisites).toMatch(/(?:DGX )?Station(?: remains|'s) Deferred/);
    expect(prerequisites).toMatch(
      /physical (?:DGX Station )?hardware|physical end-to-end validation/,
    );
    expect(quickstart).toContain("prerequisites#dgx-station-express-preparation");
    expect(quickstart).toMatch(/(?:DGX )?Station(?: remains|'s) Deferred/);
    expect(quickstart).toMatch(/physical (?:DGX Station )?hardware|physical end-to-end validation/);
  });
});
