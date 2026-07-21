// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const STATION_PREPARE = path.join(REPO_ROOT, "scripts", "prepare-dgx-station-host.sh");
const PREREQUISITES = path.join(REPO_ROOT, "docs", "get-started", "prerequisites.mdx");
const STATION_PREPARATION = path.join(
  REPO_ROOT,
  "docs",
  "get-started",
  "dgx-station-preparation.mdx",
);
const STATION_QUICKSTART = path.join(REPO_ROOT, "docs", "get-started", "quickstart.mdx");
const PLATFORM_SUPPORT = path.join(REPO_ROOT, "docs", "reference", "platform-support.mdx");
const VLLM_SETUP = path.join(REPO_ROOT, "docs", "inference", "set-up-vllm.mdx");
const WINDOWS_PREPARATION = path.join(REPO_ROOT, "docs", "get-started", "windows-preparation.mdx");
const DOCS_INDEX = path.join(REPO_ROOT, "docs", "index.yml");
const FERN_DOCS = path.join(REPO_ROOT, "fern", "docs.yml");

describe("DGX Station documentation ownership", () => {
  it("keeps Station preparation canonical and links to it from prerequisite entry points", () => {
    const helper = fs.readFileSync(STATION_PREPARE, "utf-8");
    const prerequisites = fs.readFileSync(PREREQUISITES, "utf-8");
    const stationPreparation = fs.readFileSync(STATION_PREPARATION, "utf-8");
    const quickstart = fs.readFileSync(STATION_QUICKSTART, "utf-8");
    const platformSupport = fs.readFileSync(PLATFORM_SUPPORT, "utf-8");
    const vllmSetup = fs.readFileSync(VLLM_SETUP, "utf-8");
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

    for (const version of pinnedValues) {
      expect(stationPreparation).toContain(version);
      expect(prerequisites).not.toContain(version);
      expect(quickstart).not.toContain(version);
    }
    for (const version of ["7.2.0", "7.4.0", "7.5.0"]) {
      expect(stationPreparation).toContain(version);
      expect(quickstart).toContain(version);
    }
    expect(stationPreparation).toContain("DGX Server for GALAXY-GB300");
    expect(quickstart).toContain("DGX Server for GALAXY-GB300");
    expect(stationPreparation).toContain("--force-station-install");
    expect(stationPreparation).toContain("metadata omits or varies fields");
    expect(stationPreparation).toContain("Remove the override after");
    expect(quickstart).toContain("--force-station-install");
    expect(platformSupport).toContain("explicit temporary metadata override");
    expect(platformSupport).toContain("exact read-only BDF directory");
    expect(platformSupport).toContain("they do not expose `/sys`, the PCI parent subtree");
    expect(platformSupport).toContain("`/sys/fs/cgroup/cgroup.controllers`");
    expect(platformSupport).toContain("`/sys/class/net/lo/address`");
    expect(vllmSetup).toContain("explicit temporary metadata override");
    expect(stationPreparation).toMatch(/(?:DGX )?Station(?: remains|'s) Deferred/);
    expect(stationPreparation).toContain("One physical DGX OS `7.5.0` GB300 validation completed");
    expect(stationPreparation).toContain("[Platform Support](../../reference/platform-support)");
    expect(prerequisites).toContain("### DGX Station Express Preparation");
    expect(prerequisites).toMatch(/\| DGX OS \(Station\) \| Docker \| Deferred \|/);
    expect(prerequisites).toContain("additional-setup/dgx-station-preparation");
    expect(prerequisites).toContain(
      "[Additional Setup for DGX Station](additional-setup/dgx-station-preparation)",
    );
    expect(prerequisites).toContain(
      "[Additional Setup for Windows Machines](additional-setup/windows-preparation)",
    );
    expect(quickstart).toContain("additional-setup/dgx-station-preparation");
    expect(quickstart).not.toContain("prerequisites#dgx-station-express-preparation");
    expect(quickstart).toMatch(/(?:DGX )?Station(?: remains|'s) Deferred/);
    expect(quickstart).toContain("One physical DGX OS `7.5.0` GB300 validation completed");
  });

  it("labels platform-specific prerequisite pages as additional setup", () => {
    const stationPreparation = fs.readFileSync(STATION_PREPARATION, "utf-8");
    const windowsPreparation = fs.readFileSync(WINDOWS_PREPARATION, "utf-8");
    const docsIndex = fs.readFileSync(DOCS_INDEX, "utf-8");

    expect(stationPreparation).toContain('title: "Prepare DGX Station to Install NemoClaw"');
    expect(stationPreparation).toContain('sidebar-title: "Additional Setup for DGX Station"');
    expect(windowsPreparation).toContain('title: "Prepare a Windows Machine to Install NemoClaw"');
    expect(windowsPreparation).toContain('sidebar-title: "Additional Setup for Windows Machines"');
    expect(docsIndex.match(/page: "Prerequisites"/g)).toHaveLength(3);
    expect(docsIndex).not.toContain('section: "Prerequisites"');
    expect(
      docsIndex.match(/section: "Additional Setup"\n\s+slug: additional-setup\n\s+contents:/g),
    ).toHaveLength(3);
    expect(docsIndex.match(/page: "Additional Setup for DGX Station"/g)).toHaveLength(3);
    expect(docsIndex.match(/page: "Additional Setup for Windows Machines"/g)).toHaveLength(3);
  });

  it("redirects every retired Prerequisites child route directly to Additional Setup", () => {
    const redirects = fs.readFileSync(FERN_DOCS, "utf-8");
    const pages = ["dgx-station-preparation", "windows-preparation"];
    const variantPrefixes = [
      "/nemoclaw/latest/user-guide/:variant",
      "/nemoclaw/user-guide/:variant",
    ];

    for (const prefix of variantPrefixes) {
      for (const page of pages) {
        for (const suffix of ["", ".html", "/index.html", ".md", ".mdx"]) {
          const destinationSuffix = suffix === ".md" || suffix === ".mdx" ? suffix : "";
          expect(redirects).toContain(
            `- source: "${prefix}/get-started/prerequisites/${page}${suffix}"\n    destination: "${prefix}/get-started/additional-setup/${page}${destinationSuffix}"`,
          );
        }
      }
    }

    for (const [legacyPrefix, destinationPrefix] of [
      ["/nemoclaw/latest", "/nemoclaw/latest/user-guide/openclaw"],
      ["/nemoclaw", "/nemoclaw/user-guide/openclaw"],
    ]) {
      for (const page of pages) {
        for (const suffix of ["", ".html", "/index.html"]) {
          expect(redirects).toContain(
            `- source: "${legacyPrefix}/get-started/prerequisites/${page}${suffix}"\n    destination: "${destinationPrefix}/get-started/additional-setup/${page}"`,
          );
        }
      }
    }
  });
});
