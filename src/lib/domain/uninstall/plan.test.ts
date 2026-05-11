// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { defaultUninstallPaths } from "./paths";
import { buildUninstallPlan, flattenUninstallPlan } from "./plan";

describe("uninstall plan", () => {
  it("models the six uninstall.sh cleanup steps", () => {
    const paths = defaultUninstallPaths({ home: "/home/test", tmpDir: "/tmp/nemo" });
    const plan = buildUninstallPlan(paths, {
      deleteModels: false,
      keepOpenShell: false,
      shim: { kind: "managed-wrapper", reason: "installer-managed wrapper contents", remove: true },
    });

    expect(plan.steps.map((step) => step.name)).toEqual([
      "Stopping services",
      "OpenShell resources",
      "NemoClaw CLI",
      "Docker resources",
      "Ollama models",
      "State and binaries",
    ]);
    expect(flattenUninstallPlan(plan)).toEqual(
      expect.arrayContaining([
        { kind: "delete-openshell-provider", name: "nvidia-nim" },
        { kind: "destroy-openshell-gateway", name: "nemoclaw" },
        { kind: "delete-shim", reason: "installer-managed wrapper contents" },
        { kind: "delete-related-docker-containers" },
        { kind: "delete-related-docker-images" },
        { kind: "delete-docker-volume", name: "openshell-cluster-nemoclaw" },
        { kind: "preserve-ollama-models", names: ["nemotron-3-super:120b", "nemotron-3-nano:30b"] },
        { kind: "delete-managed-swap" },
        { kind: "delete-openshell-binary", path: "/usr/local/bin/openshell" },
        { kind: "stop-ollama-auth-proxy" },
      ]),
    );

    // The Ollama auth proxy must be stopped during the "Stopping services"
    // step, before any "State and binaries" cleanup deletes the PID file.
    // Otherwise a stale proxy on :11435 blocks reinstall (issue #2759).
    const stoppingServicesStep = plan.steps.find((step) => step.name === "Stopping services");
    expect(stoppingServicesStep).toBeTruthy();
    expect(stoppingServicesStep?.actions).toEqual(
      expect.arrayContaining([{ kind: "stop-ollama-auth-proxy" }]),
    );
  });

  it("respects delete-models, keep-openshell, custom gateway, and foreign shim decisions", () => {
    const paths = defaultUninstallPaths({ home: "/home/test", xdgBinHome: "/bin" });
    const actions = flattenUninstallPlan(
      buildUninstallPlan(paths, {
        deleteModels: true,
        gatewayName: "custom",
        keepOpenShell: true,
        shim: { kind: "preserve-foreign-file", reason: "regular file is not an installer-managed shim", remove: false },
      }),
    );

    expect(actions).toEqual(expect.arrayContaining([{ kind: "delete-docker-volume", name: "openshell-cluster-custom" }]));
    expect(actions).toEqual(expect.arrayContaining([{ kind: "delete-ollama-model", name: "nemotron-3-super:120b" }]));
    expect(actions).toEqual(
      expect.arrayContaining([{ kind: "preserve-openshell-binary", paths: ["/usr/local/bin/openshell", "/bin/openshell"] }]),
    );
    expect(actions).toEqual(
      expect.arrayContaining([{ kind: "preserve-shim", reason: "regular file is not an installer-managed shim" }]),
    );
  });
});
