// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");
const K8S_MANIFEST = path.join(ROOT, "k8s", "nemoclaw-k8s.yaml");

describe("security configuration hardening", () => {
  it("gates insecure Control UI auth behind explicit opt-in and loopback-only origins", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf8");
    expect(dockerfile).toMatch(/^ARG NEMOCLAW_INSECURE_LOCAL_UI=0$/m);
    expect(dockerfile).toContain("NEMOCLAW_INSECURE_LOCAL_UI=${NEMOCLAW_INSECURE_LOCAL_UI}");
    expect(dockerfile).toContain("os.environ.get('NEMOCLAW_INSECURE_LOCAL_UI', '0')");
    expect(dockerfile).toContain("loopback_hosts = {'127.0.0.1', 'localhost', '::1'}");
    expect(dockerfile).toContain("all(host and host in loopback_hosts for host in origin_hosts)");
    expect(dockerfile).toContain("enable_insecure_local_ui = insecure_local_ui and loopback_only_origins");
    expect(dockerfile).not.toContain("'allowInsecureAuth': True");
    expect(dockerfile).not.toContain("'dangerouslyDisableDeviceAuth': True");
    expect(dockerfile).toContain("'allowInsecureAuth': enable_insecure_local_ui");
    expect(dockerfile).toContain("'dangerouslyDisableDeviceAuth': enable_insecure_local_ui");
  });

  it("hardens the Kubernetes sample manifest with safer defaults", () => {
    const manifest = fs.readFileSync(K8S_MANIFEST, "utf8");
    const workspaceMatch = manifest.match(/- name: workspace[\s\S]*?(?=\n\s*-\s*name: |\n\s*initContainers:|\n\s*volumes:|$)/);
    expect(workspaceMatch).not.toBeNull();
    const workspaceSection = workspaceMatch[0];
    expect(manifest).toMatch(/automountServiceAccountToken:\s*false/);
    expect(manifest).toMatch(/enableServiceLinks:\s*false/);
    expect(workspaceSection).toMatch(/allowPrivilegeEscalation:\s*false/);
    expect(workspaceSection).toMatch(/capabilities:\s*[\r\n]+\s*drop:\s*[\r\n]+\s*-\s*ALL/);
    expect(workspaceSection).toMatch(/seccompProfile:\s*[\r\n]+\s*type:\s*RuntimeDefault/);
    expect(manifest).toMatch(/- name: NEMOCLAW_POLICY_MODE[\s\S]*value:\s*"suggested"/);
    expect(manifest).toContain('export COMPATIBLE_API_KEY="${COMPATIBLE_API_KEY:-dummy}"');
    const compatibleApiKeySection = manifest.match(
      /- name: COMPATIBLE_API_KEY[\s\S]*?(?=\n\s*-\s*name: |\n\s*volumeMounts:|\n\s*command:|$)/
    )?.[0];
    expect(compatibleApiKeySection).toBeTruthy();
    expect(compatibleApiKeySection).toMatch(
      /secretKeyRef:[\s\S]*name:\s*nemoclaw-compatible-api-key/
    );
    expect(compatibleApiKeySection).toMatch(/optional:\s*true/);
    expect(manifest).toContain("curl --proto '=https' --tlsv1.2 --fail --show-error --silent");
    expect(manifest).toContain("--output /tmp/nemoclaw-install.sh");
    expect(manifest).toContain("chmod 700 /tmp/nemoclaw-install.sh");
    expect(manifest).toContain("bash /tmp/nemoclaw-install.sh");
    expect(manifest).not.toMatch(/curl\b[^\n|]*\|\s*(?:ba|z|k)?sh\b/i);
  });
});
