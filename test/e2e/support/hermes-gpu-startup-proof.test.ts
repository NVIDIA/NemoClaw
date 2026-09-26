// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { openshellMainProcessSpecEnvValue } from "../../../src/lib/onboard/docker-startup-command-env.ts";
import type { ManagedWorkloadAuthority } from "../../../src/lib/onboard/workload/authority.ts";
import {
  assertHermesContainerImageAuthority,
  assertHermesGpuStartupOutputContract,
  assertHermesManagedWorkloadAuthority,
  buildHermesGpuFailureCaptureScript,
  HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS,
  hermesRuntimeIntendedCommand,
  normalizeImmutableImageContentId,
} from "../live/hermes-gpu-startup-proof.ts";

const HEALTHY_NEW_GATEWAY = [
  "Container runtime: docker",
  "  Starting OpenShell gateway...",
  "Docker-driver gateway is healthy",
].join("\n");
const HEALTHY_PODMAN_GATEWAY = [
  "  ✓ Podman runtime: rootless server 6.1.0 (client 6.1.0), cgroups v2, linux/amd64",
  "  Starting OpenShell gateway via managed service...",
  "  ✓ OpenShell gateway managed service is healthy",
].join("\n");
const NON_FALLBACK_DISCLOSURE_CASES = [
  ["native-success", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[0]],
  ["native-success", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[1]],
  ["native-success", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[2]],
  ["native-success", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[3]],
  ["native-success", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[4]],
  ["compatibility-only", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[0]],
  ["compatibility-only", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[1]],
  ["compatibility-only", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[2]],
  ["compatibility-only", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[3]],
  ["compatibility-only", HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS[4]],
] as const;
const MANAGED_IMAGE_REFERENCE = `ghcr.io/nvidia/test@sha256:${"a".repeat(64)}`;
const MANAGED_IMAGE_CONTENT_ID = `sha256:${"c".repeat(64)}`;
const OTHER_MANAGED_IMAGE_REFERENCE = `ghcr.io/nvidia/test@sha256:${"b".repeat(64)}`;
const VALID_MANAGED_AUTHORITY = {
  agent: "hermes",
  contract: { agent: "hermes", reference: MANAGED_IMAGE_REFERENCE },
  profile: { agent: "hermes" },
  receipt: { kind: "managed-image", reference: MANAGED_IMAGE_REFERENCE },
} as unknown as ManagedWorkloadAuthority;

describe("Hermes GPU startup output contract", () => {
  it("accepts observed Podman managed-service startup output", () => {
    expect(() =>
      assertHermesGpuStartupOutputContract("native-success", "podman", HEALTHY_PODMAN_GATEWAY),
    ).not.toThrow();
  });

  it.each([
    ["docker", HEALTHY_PODMAN_GATEWAY],
    ["podman", HEALTHY_NEW_GATEWAY],
    ["podman", HEALTHY_PODMAN_GATEWAY.replace(" is healthy", " is unavailable")],
  ] as const)("rejects a wrong runtime or unhealthy gateway for %s", (runtime, output) => {
    expect(() => assertHermesGpuStartupOutputContract("native-success", runtime, output)).toThrow();
  });

  it.each(["native-success", "compatibility-only"] as const)(
    "accepts %s output without legacy Docker container progress text (#9362)",
    (route) => {
      expect(() =>
        assertHermesGpuStartupOutputContract(route, "docker", HEALTHY_NEW_GATEWAY),
      ).not.toThrow();
    },
  );

  it("accepts fallback output only with the complete operator disclosure (#9362)", () => {
    const output = [
      HEALTHY_NEW_GATEWAY,
      "Operator-authorized GPU fallback enabled; trying native OpenShell injection with one compatibility retry.",
      ...HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS,
    ].join("\n");

    expect(() =>
      assertHermesGpuStartupOutputContract("compatibility-fallback", "docker", output),
    ).not.toThrow();
  });

  it.each(HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS)(
    "rejects fallback output that omits %s (#9362)",
    (missingFragment) => {
      const output = [
        HEALTHY_NEW_GATEWAY,
        "Operator-authorized GPU fallback enabled; trying native OpenShell injection with one compatibility retry.",
        ...HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS.filter(
          (fragment) => fragment !== missingFragment,
        ),
      ].join("\n");

      expect(() =>
        assertHermesGpuStartupOutputContract("compatibility-fallback", "docker", output),
      ).toThrow();
    },
  );

  it.each(NON_FALLBACK_DISCLOSURE_CASES)(
    "rejects fallback disclosure in %s output: %s (#9362)",
    (route, fragment) => {
      expect(() =>
        assertHermesGpuStartupOutputContract(
          route,
          "docker",
          `${HEALTHY_NEW_GATEWAY}\n${fragment}`,
        ),
      ).toThrow();
    },
  );
});

describe("Hermes GPU managed-image authority proof", () => {
  it("reads the OpenShell 0.0.116 structured main-process command", () => {
    const command = ["env", "CHAT_UI_URL=http://127.0.0.1:18789", "/usr/local/bin/nemoclaw-start"];

    expect(
      hermesRuntimeIntendedCommand({
        OPENSHELL_MAIN_PROCESS_SPEC: openshellMainProcessSpecEnvValue(command, false),
      }),
    ).toEqual(command);
    expect(command).not.toContain("/usr/local/bin/nemoclaw-managed-bootstrap");
  });

  it("retains the legacy OpenShell sandbox-command fallback", () => {
    expect(
      hermesRuntimeIntendedCommand({
        OPENSHELL_SANDBOX_COMMAND:
          "env CHAT_UI_URL=http://127.0.0.1:18789 /usr/local/bin/nemoclaw-start",
      }),
    ).toEqual(["env", "CHAT_UI_URL=http://127.0.0.1:18789", "/usr/local/bin/nemoclaw-start"]);
  });

  it("canonicalizes a Podman bare image content ID without changing canonical Docker IDs", () => {
    expect(normalizeImmutableImageContentId("c".repeat(64))).toBe(MANAGED_IMAGE_CONTENT_ID);
    expect(normalizeImmutableImageContentId(MANAGED_IMAGE_CONTENT_ID)).toBe(
      MANAGED_IMAGE_CONTENT_ID,
    );
    expect(normalizeImmutableImageContentId("not-an-image-id")).toBe("not-an-image-id");
  });

  it("accepts one immutable authority shared by the registry, contract, and receipt (#9362)", () => {
    expect(
      assertHermesManagedWorkloadAuthority(
        "hermes-gpu",
        MANAGED_IMAGE_REFERENCE,
        VALID_MANAGED_AUTHORITY,
      ),
    ).toBe(MANAGED_IMAGE_REFERENCE);
  });

  it("rejects a missing managed workload authority (#9362)", () => {
    expect(() =>
      assertHermesManagedWorkloadAuthority("hermes-gpu", MANAGED_IMAGE_REFERENCE, null),
    ).toThrow("has no managed workload authority");
  });

  it.each([
    ["agent", { ...VALID_MANAGED_AUTHORITY, agent: "openclaw" }],
    [
      "contract agent",
      {
        ...VALID_MANAGED_AUTHORITY,
        contract: { ...VALID_MANAGED_AUTHORITY.contract, agent: "pi" },
      },
    ],
    [
      "contract reference",
      {
        ...VALID_MANAGED_AUTHORITY,
        contract: {
          ...VALID_MANAGED_AUTHORITY.contract,
          reference: "different-reference",
        },
      },
    ],
    ["profile agent", { ...VALID_MANAGED_AUTHORITY, profile: { agent: "openclaw" } }],
    [
      "receipt kind",
      {
        ...VALID_MANAGED_AUTHORITY,
        receipt: { ...VALID_MANAGED_AUTHORITY.receipt, kind: "custom" },
      },
    ],
  ] as const)("rejects managed authority drift in %s (#9362)", (_label, authority) => {
    expect(() =>
      assertHermesManagedWorkloadAuthority(
        "hermes-gpu",
        MANAGED_IMAGE_REFERENCE,
        authority as unknown as ManagedWorkloadAuthority,
      ),
    ).toThrow();
  });

  it("rejects registry-to-receipt image drift (#9362)", () => {
    expect(() =>
      assertHermesManagedWorkloadAuthority(
        "hermes-gpu",
        OTHER_MANAGED_IMAGE_REFERENCE,
        VALID_MANAGED_AUTHORITY,
      ),
    ).toThrow();
  });

  it.each([
    "ghcr.io/nvidia/test:latest",
    "ghcr.io/nvidia/test@sha256:different",
    `ghcr.io/nvidia/test@sha256:${"A".repeat(64)}`,
  ])("rejects matching mutable or malformed image authority: %s (#9362)", (reference) => {
    const authority = {
      ...VALID_MANAGED_AUTHORITY,
      contract: { ...VALID_MANAGED_AUTHORITY.contract, reference },
      receipt: { ...VALID_MANAGED_AUTHORITY.receipt, reference },
    } as unknown as ManagedWorkloadAuthority;

    expect(() => assertHermesManagedWorkloadAuthority("hermes-gpu", reference, authority)).toThrow(
      "has no immutable image reference",
    );
  });

  it("accepts the running container's exact digest-backed authority (#9362)", () => {
    expect(() =>
      assertHermesContainerImageAuthority(MANAGED_IMAGE_REFERENCE, MANAGED_IMAGE_REFERENCE),
    ).not.toThrow();
  });

  it("accepts the provider content ID resolved from the exact digest-backed authority", () => {
    expect(() =>
      assertHermesContainerImageAuthority(
        MANAGED_IMAGE_CONTENT_ID,
        MANAGED_IMAGE_REFERENCE,
        MANAGED_IMAGE_CONTENT_ID,
      ),
    ).not.toThrow();
  });

  it("accepts Podman's bare running-container content ID for the recorded authority", () => {
    expect(() =>
      assertHermesContainerImageAuthority(
        "c".repeat(64),
        MANAGED_IMAGE_REFERENCE,
        MANAGED_IMAGE_CONTENT_ID,
      ),
    ).not.toThrow();
  });

  it("rejects a running container outside the recorded authority (#9362)", () => {
    expect(() =>
      assertHermesContainerImageAuthority("ghcr.io/nvidia/test:latest", MANAGED_IMAGE_REFERENCE),
    ).toThrow();
  });
});

describe("Hermes GPU failure capture", () => {
  it.each([
    ["container found", 0, "container-id\n", 4, false],
    ["successful empty query", 0, "", 1, true],
    ["failed query", 17, "", 1, false],
  ] as const)(
    "preserves runtime argv and distinguishes %s",
    (_label, status, output, calls, absent) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-gpu-capture-"));
      const runtime = path.join(directory, "runtime command with spaces");
      const callsFile = path.join(directory, "calls");
      const endpoint = "unix:///tmp/podman context.sock";
      fs.writeFileSync(
        runtime,
        `#!/bin/bash
printf '%s\\n' '__CALL__' "$@" >> "$CALLS_FILE"
case "$4" in
  ps) printf '%s' "$QUERY_OUTPUT"; printf '%s' query-stderr >&2; exit "$QUERY_STATUS" ;;
  *) printf '%s\\n' runtime-detail ;;
esac
`,
        { mode: 0o700 },
      );
      try {
        const result = spawnSync(
          "bash",
          [
            "--noprofile",
            "--norc",
            "-c",
            buildHermesGpuFailureCaptureScript(),
            "capture",
            "label=openshell.ai/sandbox-name=fixture",
            "",
            runtime,
            "--url",
            endpoint,
          ],
          {
            encoding: "utf8",
            timeout: 5000,
            env: {
              ...process.env,
              BASH_ENV: "/dev/null",
              CALLS_FILE: callsFile,
              QUERY_OUTPUT: output,
              QUERY_STATUS: String(status),
            },
          },
        );
        expect(result.status, result.stderr).toBe(status);
        expect(result.stdout.includes("no runtime container found")).toBe(absent);
        expect(result.stderr).toContain("query-stderr");
        const invocations = fs.readFileSync(callsFile, "utf8").split("__CALL__\n").slice(1);
        expect(invocations).toHaveLength(calls);
        expect(invocations[0].trim().split("\n")).toEqual([
          "--url",
          endpoint,
          "container",
          "ps",
          "--all",
          "--quiet",
          "--filter",
          "label=openshell.ai/sandbox-name=fixture",
        ]);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
