// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ROOT } from "../runner";
import {
  buildCuaRuntimeReadiness,
  loadCuaReleaseArtifactManifest,
  requireQualifiedCuaRuntimeReadiness,
} from "./runtime-readiness";

const agent = {
  name: "nemocua",
  agentDir: path.join(ROOT, "agents", "nemocua"),
};

describe("NemoCUA runtime readiness", () => {
  it("binds canonical readiness to the exact pinned release artifacts (#7755)", () => {
    const artifacts = loadCuaReleaseArtifactManifest(agent);
    const readiness = buildCuaRuntimeReadiness(agent, "nvidia", "nemotron");

    expect(artifacts.hostCli.version).toBe("0.0.20-dev-v3");
    expect(readiness.status).toBe("unavailable");
    expect(readiness.components.runtime.digest).toBe(
      "sha256:702d93c4fc01ba4aafdd23daaf17fd25cea8f7deab3f1caa1c91ef047f4778aa",
    );
    expect(readiness.components.sandboxImage.digest).toBe(
      "sha256:c1a577fc8f69071642b97706130df26abd8a89b8bd429a9ef37abf0ccd634e0b",
    );
    expect(readiness.inference).toEqual({ provider: "nvidia", model: "nemotron" });
  });

  it("refuses to publish available readiness before live tuple qualification (#7755)", () => {
    expect(() => requireQualifiedCuaRuntimeReadiness(agent, "nvidia", "nemotron")).toThrow(
      "have not passed live tuple qualification",
    );
  });

  it("keeps the in-sandbox runtime free of nested sandbox creation (#7755)", () => {
    const wrapper = fs.readFileSync(path.join(agent.agentDir, "nemocua-runtime.sh"), "utf8");
    expect(wrapper).not.toMatch(/nemocua\s+sandbox\s+create/);
    expect(wrapper).toContain("run_with_harness.py");
  });
});
