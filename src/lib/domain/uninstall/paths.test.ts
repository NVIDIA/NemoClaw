// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it } from "vitest";

import { defaultUninstallPaths, gatewayVolumeCandidates, uninstallStatePaths } from "./paths";

describe("uninstall paths", () => {
  it("returns the gateway volume candidate used by uninstall.sh", () => {
    expect(gatewayVolumeCandidates("nemoclaw")).toEqual(["openshell-cluster-nemoclaw"]);
  });

  it("builds host state, shim, OpenShell, and temp cleanup paths", () => {
    const paths = defaultUninstallPaths({ home: "/home/test", tmpDir: "/tmp/nemo", xdgBinHome: "/xdg/bin" });

    expect(paths.nemoclawStateDir).toBe(path.join("/home/test", ".nemoclaw"));
    expect(paths.openshellConfigDir).toBe(path.join("/home/test", ".config", "openshell"));
    expect(paths.nemoclawConfigDir).toBe(path.join("/home/test", ".config", "nemoclaw"));
    expect(paths.nemoclawShimPath).toBe(path.join("/home/test", ".local", "bin", "nemoclaw"));
    expect(paths.openshellInstallPaths).toEqual(["/usr/local/bin/openshell", path.join("/xdg/bin", "openshell")]);
    expect(paths.helperServiceGlob).toBe(path.join("/tmp/nemo", "nemoclaw-services-*"));
    expect(paths.runtimeTempGlobs).toEqual([
      path.join("/tmp/nemo", "nemoclaw-create-*.log"),
      path.join("/tmp/nemo", "nemoclaw-tg-ssh-*.conf"),
    ]);
  });

  it("defaults repoRoot outside src/dist module directories", () => {
    const paths = defaultUninstallPaths({ home: "/home/test" });
    expect(paths.repoRoot.endsWith(`${path.sep}src`)).toBe(false);
    expect(paths.repoRoot.endsWith(`${path.sep}dist`)).toBe(false);
  });

  it("returns state removal paths in shell cleanup order", () => {
    const paths = defaultUninstallPaths({ home: "/home/test" });
    expect(uninstallStatePaths(paths)).toEqual([
      path.join("/home/test", ".nemoclaw"),
      path.join("/home/test", ".config", "openshell"),
      path.join("/home/test", ".config", "nemoclaw"),
    ]);
  });
});
