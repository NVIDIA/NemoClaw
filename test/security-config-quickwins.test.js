// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");
const K8S_MANIFEST = path.join(ROOT, "k8s", "nemoclaw-k8s.yaml");

describe("security config quick wins", () => {
  it("gates insecure Control UI auth behind explicit opt-in and loopback-only origins", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
    expect(dockerfile).toMatch(/^ARG NEMOCLAW_INSECURE_LOCAL_UI=0$/m);
    expect(dockerfile).toContain("NEMOCLAW_INSECURE_LOCAL_UI=${NEMOCLAW_INSECURE_LOCAL_UI}");
    expect(dockerfile).toContain("os.environ.get('NEMOCLAW_INSECURE_LOCAL_UI', '0')");
    expect(dockerfile).toContain("loopback_hosts = {'127.0.0.1', 'localhost', '::1'}");
    expect(dockerfile).toContain("enable_insecure_local_ui = insecure_local_ui and loopback_only_origins");
    expect(dockerfile).not.toContain("'allowInsecureAuth': True");
    expect(dockerfile).not.toContain("'dangerouslyDisableDeviceAuth': True");
    expect(dockerfile).toContain("'allowInsecureAuth': enable_insecure_local_ui");
    expect(dockerfile).toContain("'dangerouslyDisableDeviceAuth': enable_insecure_local_ui");
  });

  it("hardens the Kubernetes sample manifest with safer defaults", () => {
    const manifest = fs.readFileSync(K8S_MANIFEST, "utf8");
    expect(manifest).toMatch(/automountServiceAccountToken:\s*false/);
    expect(manifest).toMatch(/enableServiceLinks:\s*false/);
    expect(manifest).toMatch(/- name: workspace[\s\S]*allowPrivilegeEscalation:\s*false/);
    expect(manifest).toMatch(/- name: workspace[\s\S]*seccompProfile:\s*[\r\n]+\s*type:\s*RuntimeDefault/);
    expect(manifest).toMatch(/- name: NEMOCLAW_POLICY_MODE[\s\S]*value:\s*"suggested"/);
    expect(manifest).toContain("curl -fsSLo /tmp/nemoclaw-install.sh https://www.nvidia.com/nemoclaw.sh");
    expect(manifest).toContain("bash /tmp/nemoclaw-install.sh");
    expect(manifest).not.toContain("curl -fsSL https://nvidia.com/nemoclaw.sh | bash");
  });
});
