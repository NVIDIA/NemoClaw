// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";

// Build must run before these tests (imports from dist/)
const require = createRequire(import.meta.url);
const {
  isDirectContainerDriver,
  selectPrivilegedSandboxContainer,
  buildPrivilegedExecArgv,
  buildDirectContainerExecArgv,
  buildKubectlExecArgv,
  LEGACY_K3S_GATEWAY_CONTAINER,
} = require("../dist/lib/sandbox/privileged-container");

describe("isDirectContainerDriver", () => {
  it("recognizes the docker and vm drivers", () => {
    expect(isDirectContainerDriver("docker")).toBe(true);
    expect(isDirectContainerDriver("vm")).toBe(true);
  });

  it("rejects legacy k3s/kubernetes and unknown drivers", () => {
    expect(isDirectContainerDriver("kubernetes")).toBe(false);
    expect(isDirectContainerDriver("k3s")).toBe(false);
    expect(isDirectContainerDriver("podman")).toBe(false);
  });

  it("treats null/undefined/empty as not direct-container", () => {
    expect(isDirectContainerDriver(null)).toBe(false);
    expect(isDirectContainerDriver(undefined)).toBe(false);
    expect(isDirectContainerDriver("")).toBe(false);
  });
});

describe("selectPrivilegedSandboxContainer", () => {
  it("resolves the exact `openshell-<sandbox>` container for the docker driver", () => {
    expect(
      selectPrivilegedSandboxContainer(
        "demo",
        "docker",
        "openshell-demo\nopenshell-other-aa11",
      ),
    ).toBe("openshell-demo");
  });

  it("resolves the exact `openshell-<sandbox>` container for the vm driver (#4245)", () => {
    // macOS Docker Desktop with the OpenShell VM driver: no k3s container
    // exists, but the sandbox container shows up on the host docker engine.
    expect(
      selectPrivilegedSandboxContainer(
        "my-assistant",
        "vm",
        "openshell-my-assistant\n",
        ["my-assistant"],
      ),
    ).toBe("openshell-my-assistant");
  });

  it("falls back to a suffixed `openshell-<sandbox>-<id>` container for the vm driver", () => {
    expect(
      selectPrivilegedSandboxContainer(
        "my-assistant",
        "vm",
        "openshell-my-assistant-12ab\n",
        ["my-assistant"],
      ),
    ).toBe("openshell-my-assistant-12ab");
  });

  it("returns null for legacy kubernetes-driver sandboxes so callers fall back to kubectl", () => {
    expect(
      selectPrivilegedSandboxContainer(
        "demo",
        "kubernetes",
        "openshell-demo\nopenshell-cluster-nemoclaw\n",
      ),
    ).toBeNull();
  });

  it("returns null when the driver is null/undefined", () => {
    expect(
      selectPrivilegedSandboxContainer("demo", null, "openshell-demo\n"),
    ).toBeNull();
    expect(
      selectPrivilegedSandboxContainer("demo", undefined, "openshell-demo\n"),
    ).toBeNull();
  });

  it("returns null when no matching container is present", () => {
    expect(
      selectPrivilegedSandboxContainer(
        "demo",
        "docker",
        "openshell-other\nopenshell-cluster-nemoclaw\n",
      ),
    ).toBeNull();
  });

  it("does not steal another sandbox's container when its name is a prefix", () => {
    // Looking up `my` must not match `openshell-my-assistant-12ab`.
    expect(
      selectPrivilegedSandboxContainer(
        "my",
        "vm",
        "openshell-my-assistant-12ab\n",
        ["my", "my-assistant"],
      ),
    ).toBeNull();
  });

  it("does not steal a hyphenated sandbox's container when its name is a prefix and the suffix is hyphen-free", () => {
    expect(
      selectPrivilegedSandboxContainer(
        "my-assistant",
        "vm",
        "openshell-my-assistant-prod\n",
        ["my-assistant", "my-assistant-prod"],
      ),
    ).toBeNull();
  });

  it("prefers the exact-name container over a docker-runtime-suffixed sibling", () => {
    // openshell-my-12ab is a stale same-sandbox alternate container; only
    // `my` is registered, so the longest-known-name heuristic alone would
    // still resolve the suffixed candidate to `my`. The exact name must
    // always win.
    expect(
      selectPrivilegedSandboxContainer(
        "my",
        "vm",
        "openshell-my-12ab\nopenshell-my\n",
        ["my"],
      ),
    ).toBe("openshell-my");
  });

  it("attributes a hyphenated container to the longest registered sandbox name", () => {
    expect(
      selectPrivilegedSandboxContainer(
        "my-assistant",
        "vm",
        "openshell-my-assistant-prod-abc\n",
        ["my-assistant", "my-assistant-prod"],
      ),
    ).toBeNull();
  });
});

describe("buildPrivilegedExecArgv", () => {
  it("uses `docker exec --user root <container>` for direct-container drivers (#4245)", () => {
    expect(
      buildPrivilegedExecArgv(
        "my-assistant",
        ["chmod", "444", "/sandbox/.openclaw/openclaw.json"],
        "openshell-my-assistant",
      ),
    ).toEqual([
      "exec",
      "--user",
      "root",
      "openshell-my-assistant",
      "chmod",
      "444",
      "/sandbox/.openclaw/openclaw.json",
    ]);
  });

  it("falls back to the legacy k3s/kubectl path when no direct container is resolved", () => {
    expect(
      buildPrivilegedExecArgv(
        "my-assistant",
        ["chmod", "444", "/sandbox/.openclaw/openclaw.json"],
        null,
      ),
    ).toEqual([
      "exec",
      "openshell-cluster-nemoclaw",
      "kubectl",
      "exec",
      "-n",
      "openshell",
      "my-assistant",
      "-c",
      "agent",
      "--",
      "chmod",
      "444",
      "/sandbox/.openclaw/openclaw.json",
    ]);
  });

  it("threads -i into both docker exec and kubectl exec on the legacy path", () => {
    const argv = buildPrivilegedExecArgv(
      "demo",
      ["sh", "-c", "cat > /tmp/out"],
      null,
      { stdin: true },
    );

    // -i must appear once for `docker exec -i ...` and once for the inner
    // `kubectl exec -i ...` so stdin reaches the in-pod process.
    expect(argv[0]).toBe("exec");
    expect(argv[1]).toBe("-i");
    expect(argv).toContain("kubectl");
    const kubectlIdx = argv.indexOf("kubectl");
    expect(argv.slice(kubectlIdx).filter((arg: string) => arg === "-i")).toHaveLength(1);
  });

  it("threads -i into the direct-container path for config writes", () => {
    expect(
      buildPrivilegedExecArgv(
        "demo",
        ["sh", "-c", "cat > /tmp/out"],
        "openshell-demo",
        { stdin: true },
      ),
    ).toEqual([
      "exec",
      "-i",
      "--user",
      "root",
      "openshell-demo",
      "sh",
      "-c",
      "cat > /tmp/out",
    ]);
  });
});

describe("buildDirectContainerExecArgv / buildKubectlExecArgv", () => {
  it("buildDirectContainerExecArgv emits a `docker exec --user root` argv", () => {
    expect(
      buildDirectContainerExecArgv("openshell-demo", ["whoami"]),
    ).toEqual(["exec", "--user", "root", "openshell-demo", "whoami"]);
  });

  it("buildKubectlExecArgv targets the legacy gateway container", () => {
    expect(buildKubectlExecArgv("demo", ["whoami"]).slice(0, 3)).toEqual([
      "exec",
      LEGACY_K3S_GATEWAY_CONTAINER,
      "kubectl",
    ]);
  });

  it("LEGACY_K3S_GATEWAY_CONTAINER pins the legacy container name", () => {
    expect(LEGACY_K3S_GATEWAY_CONTAINER).toBe("openshell-cluster-nemoclaw");
  });
});
