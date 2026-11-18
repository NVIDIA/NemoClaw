// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openshellMainProcessSpecEnvValue } from "../../../src/lib/onboard/docker-startup-command-env.ts";
import type { ManagedWorkloadAuthority } from "../../../src/lib/onboard/workload/authority.ts";
import {
  assertHermesContainerImageAuthority,
  buildHermesGpuInferenceCommand,
  assertHermesGpuStartupOutputContract,
  assertHermesManagedWorkloadAuthority,
  HERMES_GPU_FALLBACK_DISCLOSURE_FRAGMENTS,
  hermesRuntimeIntendedCommand,
  hermesGpuRuntimePair,
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

function liveFailedGpuDiagnosticScript(): string {
  const source = readFileSync(
    new URL("../live/hermes-gpu-startup.test.ts", import.meta.url),
    "utf8",
  );
  const marker = "String.raw`set -eu\nsandbox_filter=";
  const start = source.indexOf(marker);
  expect(start, "Hermes GPU live diagnostic probe missing").toBeGreaterThanOrEqual(0);
  const bodyStart = start + "String.raw`".length;
  const end = source.indexOf("`;", bodyStart);
  expect(end, "Hermes GPU live diagnostic probe unterminated").toBeGreaterThanOrEqual(0);
  return source
    .slice(bodyStart, end)
    .replaceAll('${"${runtime_command[@]}"}', "${runtime_command[@]}");
}

describe("Hermes GPU failed-container diagnostics", () => {
  it.each([
    ["found", 0],
    ["discovery-failed", 31],
  ] as const)("uses the exact runtime container identity when %s", (mode, status) => {
    const root = mkdtempSync(join(tmpdir(), "nemoclaw-hermes-gpu-diagnostic-"));
    try {
      const runtime = join(root, "runtime");
      const id = "a".repeat(64);
      writeFileSync(
        runtime,
        [
          "#!/bin/bash",
          'if [ "$1 $2" = "container ps" ]; then',
          mode === "found" ? `  printf '%s\\n' '${id}'` : "  exit 31",
          'elif [ "$1 $2" = "container inspect" ]; then',
          '  printf "%s\\n" "exited 1 false 0"',
          "else exit 32; fi",
        ].join("\n"),
      );
      chmodSync(runtime, 0o755);
      const result = spawnSync(
        "bash",
        [
          "-lc",
          liveFailedGpuDiagnosticScript(),
          "diagnostic",
          "label=openshell.ai/sandbox-name=owned",
          "",
          root,
          runtime,
        ],
        { encoding: "utf8", timeout: 5_000 },
      );
      expect(result.status, result.stderr).toBe(status);
      expect(result.stdout.includes(`== exact container ${id} state ==`)).toBe(mode === "found");
      expect(result.stdout.includes("exited 1 false 0")).toBe(mode === "found");
      expect(result.stdout).not.toContain("no runtime container found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("copies private generic diagnostics and refuses symlink or unrelated paths", () => {
    const root = mkdtempSync(join(tmpdir(), "gpu-diagnostic-path-"));
    try {
      const directory = join(root, "failure");
      mkdirSync(directory, { mode: 0o700 });
      const log = join(directory, "sandbox-container.log");
      writeFileSync(log, "redacted supervisor evidence", { mode: 0o600 });
      const runtime = join(root, "runtime");
      writeFileSync(runtime, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const run = (dir: string, expectedRoot = root) =>
        spawnSync(
          "bash",
          [
            "-lc",
            liveFailedGpuDiagnosticScript(),
            "diagnostic",
            "label=openshell.ai/sandbox-name=owned",
            dir,
            expectedRoot,
            runtime,
          ],
          { encoding: "utf8", timeout: 5_000 },
        );
      expect(run(directory).stdout).toContain("redacted supervisor evidence");
      expect(run(directory, join(root, "other")).stdout).not.toContain(
        "redacted supervisor evidence",
      );
      const alias = join(root, "alias");
      symlinkSync(directory, alias);
      expect(run(alias).stdout).not.toContain("redacted supervisor evidence");
      rmSync(log);
      writeFileSync(join(root, "private"), "must not copy", { mode: 0o600 });
      symlinkSync(join(root, "private"), log);
      expect(run(directory).stdout).not.toContain("must not copy");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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

function runHermesNativeInferenceProbe(handle: string) {
  const directory = mkdtempSync(join(tmpdir(), "hermes-gpu-native-probe-"));
  try {
    writeFileSync(join(directory, "curl"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    return spawnSync(
      "/bin/bash",
      [
        "-c",
        buildHermesGpuInferenceCommand(
          "http://host.openshell.internal:42103/v1",
          'model/$(exit 99)"quoted',
        ),
      ],
      {
        env: { PATH: `${directory}:/usr/bin:/bin`, NEMOCLAW_LOCAL_INFERENCE_TOKEN: handle },
        encoding: "utf8",
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it("sends the Hermes GPU request through its scoped native credential", () => {
  const handle = "openshell:resolve:env:v3_NEMOCLAW_LOCAL_INFERENCE_TOKEN";
  const result = runHermesNativeInferenceProbe(handle);
  expect(result.status).toBe(0);
  expect(result.stdout.trim().split("\n")).toEqual([
    "-fsS",
    "--max-time",
    "60",
    "http://host.openshell.internal:42103/v1/chat/completions",
    "-H",
    "Content-Type: application/json",
    "-H",
    `Authorization: Bearer ${handle}`,
    "--data",
    JSON.stringify({
      model: 'model/$(exit 99)"quoted',
      messages: [{ role: "user", content: "reply with OK" }],
      max_tokens: 8,
    }),
  ]);
});

it.each([
  "",
  "raw-host-key",
  "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  "openshell:resolve:env:v3_NEMOCLAW_LOCAL_INFERENCE_TOKEN\nraw-host-key",
])("rejects an unscoped Hermes GPU credential before curl (%j)", (handle) => {
  const result = runHermesNativeInferenceProbe(handle);
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
});

describe("Hermes GPU supervisor identity", () => {
  const sandboxId = "11111111-1111-4111-8111-111111111111";
  const pair = () =>
    ["sandbox", "supervisor"].map((role, index) => ({
      Id: String(index + 1).repeat(64),
      Config: {
        Env:
          role === "supervisor"
            ? [
                `OPENSHELL_MAIN_PROCESS_SPEC=${openshellMainProcessSpecEnvValue(["nemoclaw-start"], false)}`,
              ]
            : [],
        Labels: {
          "openshell.ai/managed-by": "openshell",
          "openshell.ai/sandbox-name": "owned",
          "openshell.ai/sandbox-id": sandboxId,
          "openshell.ai/sandbox-namespace": "gateway-namespace",
          ...(role === "sandbox" ? { "openshell.ai/sandbox-workspace": "default" } : {}),
          "openshell.ai/isolation-role": role,
        },
      },
    }));
  it("reads command transport from the supervisor without attributing its image to the workload", () => {
    const rows = pair();
    const result = hermesGpuRuntimePair(rows, "owned", sandboxId)!;
    expect(result.workload).toBe(rows[0]);
    expect(result.supervisor).toBe(rows[1]);
    expect(result.workload.Config.Env).toEqual([]);
    expect(
      hermesRuntimeIntendedCommand(
        Object.fromEntries(
          result.supervisor.Config.Env.map((entry) => entry.split(/=(.*)/su).slice(0, 2)),
        ),
      ),
    ).toEqual(["nemoclaw-start"]);
  });
  it.each([
    ["openshell.ai/managed-by", "foreign"],
    ["openshell.ai/sandbox-name", "other"],
    ["openshell.ai/sandbox-id", "other"],
    ["openshell.ai/sandbox-namespace", "other"],
    ["openshell.ai/sandbox-workspace", "other"],
    ["openshell.ai/isolation-role", "sandbox"],
  ])("rejects a supervisor with mismatched %s", (key, value) => {
    const rows = pair();
    Object.assign(rows[1].Config.Labels, { [key]: value });
    expect(hermesGpuRuntimePair(rows, "owned", sandboxId)).toBeNull();
  });
  it("rejects missing, duplicate and truncated container identities", () => {
    const rows = pair();
    expect(hermesGpuRuntimePair(rows.slice(0, 1), "owned", sandboxId)).toBeNull();
    expect(hermesGpuRuntimePair(rows, "owned", null)).toBeNull();
    rows[1].Id = rows[0].Id;
    expect(hermesGpuRuntimePair(rows, "owned", sandboxId)).toBeNull();
    rows[1].Id = "a".repeat(12);
    expect(hermesGpuRuntimePair(rows, "owned", sandboxId)).toBeNull();
  });
});
