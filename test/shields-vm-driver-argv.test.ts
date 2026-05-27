// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Issue #4245: `nemoclaw <sandbox> shields up/down` on macOS Docker Desktop
// with the OpenShell VM driver was routing privileged execs through
// `docker exec openshell-cluster-nemoclaw kubectl exec ...`, which fails
// because no k3s container exists in VM-driver gateways. Both shields and
// the host-side config writer must instead exec directly into the
// `openshell-<sandbox>` container.

import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

// Build must run before these tests (imports from dist/).
const require = createRequire(import.meta.url);

type SandboxEntry = {
  name: string;
  openshellDriver?: string | null;
};

const registry = require("../dist/lib/state/registry") as {
  getSandbox: (name: string) => SandboxEntry | null;
  listSandboxes: () => { sandboxes: SandboxEntry[]; defaultSandbox: string | null };
};

const dockerRun = require("../dist/lib/adapters/docker/run") as {
  dockerCapture: (args: readonly string[], opts?: unknown) => string;
};

const shields = require("../dist/lib/shields") as {
  privilegedSandboxExecArgv: (sandboxName: string, cmd: string[]) => string[];
};

const config = require("../dist/lib/sandbox/config") as {
  privilegedSandboxExecArgv: (
    sandboxName: string,
    cmd: string[],
    stdin?: boolean,
  ) => string[];
};

afterEach(() => {
  vi.restoreAllMocks();
});

function stubRegistry(opts: {
  driver: string | null;
  sandboxNames?: string[];
  containerNames: string;
}): void {
  // Every name passed in sandboxNames (plus the canonical "my-assistant") must
  // resolve through getSandbox so the prefix-collision test actually exercises
  // selectPrivilegedSandboxContainer's longest-known-name disambiguation rather
  // than falling out of resolvePrivilegedSandboxContainer's `driver == null`
  // short-circuit (CodeRabbit #4290).
  const canonicalName = "my-assistant";
  const knownSandboxNames = opts.sandboxNames ?? [canonicalName];
  vi.spyOn(registry, "getSandbox").mockImplementation((name) => {
    if (knownSandboxNames.includes(name)) {
      return { name, openshellDriver: opts.driver };
    }
    return null;
  });
  vi.spyOn(registry, "listSandboxes").mockReturnValue({
    sandboxes: knownSandboxNames.map((name) => ({
      name,
      openshellDriver: opts.driver,
    })),
    defaultSandbox: canonicalName,
  });
  vi.spyOn(dockerRun, "dockerCapture").mockReturnValue(opts.containerNames);
}

describe("shields privilegedSandboxExecArgv (#4245)", () => {
  it("targets the direct VM-driver sandbox container instead of the legacy k3s gateway", () => {
    stubRegistry({
      driver: "vm",
      containerNames: "openshell-my-assistant\nopenshell-other\n",
    });

    const argv = shields.privilegedSandboxExecArgv("my-assistant", [
      "chmod",
      "444",
      "/sandbox/.openclaw/openclaw.json",
    ]);

    expect(argv).toEqual([
      "exec",
      "--user",
      "root",
      "openshell-my-assistant",
      "chmod",
      "444",
      "/sandbox/.openclaw/openclaw.json",
    ]);
    // Defensive regression check: the legacy k3s container must not appear.
    expect(argv).not.toContain("openshell-cluster-nemoclaw");
  });

  it("still uses the direct container for the docker driver", () => {
    stubRegistry({
      driver: "docker",
      containerNames: "openshell-my-assistant-12ab\n",
    });

    const argv = shields.privilegedSandboxExecArgv("my-assistant", ["whoami"]);

    expect(argv).toEqual([
      "exec",
      "--user",
      "root",
      "openshell-my-assistant-12ab",
      "whoami",
    ]);
  });

  it("falls back to the legacy k3s/kubectl path for non-direct drivers", () => {
    stubRegistry({
      driver: "kubernetes",
      containerNames: "openshell-cluster-nemoclaw\nopenshell-my-assistant\n",
    });

    const argv = shields.privilegedSandboxExecArgv("my-assistant", ["whoami"]);

    expect(argv).toEqual([
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
      "whoami",
    ]);
  });

  it("does not steal another sandbox's container when its name is a prefix (#4245 disambiguation)", () => {
    // Only `openshell-my-assistant-12ab` is live; looking up the shorter
    // `my` must fall back to kubectl rather than mis-execing into
    // `my-assistant`'s container.
    stubRegistry({
      driver: "vm",
      sandboxNames: ["my", "my-assistant"],
      containerNames: "openshell-my-assistant-12ab\n",
    });

    const argv = shields.privilegedSandboxExecArgv("my", ["whoami"]);

    expect(argv).not.toContain("openshell-my-assistant-12ab");
    // Falls back to kubectl because no openshell-my[-id] container exists.
    expect(argv.slice(0, 3)).toEqual([
      "exec",
      "openshell-cluster-nemoclaw",
      "kubectl",
    ]);
  });
});

describe("sandbox config privilegedSandboxExecArgv (#4245)", () => {
  it("targets the direct VM-driver container for host-initiated config writes", () => {
    stubRegistry({
      driver: "vm",
      containerNames: "openshell-my-assistant\n",
    });

    const argv = config.privilegedSandboxExecArgv(
      "my-assistant",
      ["sh", "-c", "cat > /sandbox/.openclaw/openclaw.json"],
      true,
    );

    expect(argv).toEqual([
      "exec",
      "-i",
      "--user",
      "root",
      "openshell-my-assistant",
      "sh",
      "-c",
      "cat > /sandbox/.openclaw/openclaw.json",
    ]);
  });

  it("preserves the kubectl `-i` thread-through for legacy gateways", () => {
    stubRegistry({
      driver: "kubernetes",
      containerNames: "openshell-cluster-nemoclaw\n",
    });

    const argv = config.privilegedSandboxExecArgv(
      "my-assistant",
      ["sh", "-c", "cat > /tmp/foo"],
      true,
    );

    expect(argv).toEqual([
      "exec",
      "-i",
      "openshell-cluster-nemoclaw",
      "kubectl",
      "exec",
      "-n",
      "openshell",
      "my-assistant",
      "-c",
      "agent",
      "-i",
      "--",
      "sh",
      "-c",
      "cat > /tmp/foo",
    ]);
  });
});
