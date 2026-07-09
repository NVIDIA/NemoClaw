// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcileRegisteredExtraProviders } from "./extra-provider-reconciliation";

type ProbeResult = {
  status: number | null;
  error?: Error;
  output?: string | Buffer | Array<string | Buffer | null> | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reconcileRegisteredExtraProviders", () => {
  it("does not probe the gateway when no extra provider is recorded (#6501)", () => {
    const runOpenshell = vi.fn((): ProbeResult => ({ status: 0 }));

    expect(
      reconcileRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => [],
        runOpenshell,
      }),
    ).toEqual([]);
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("probes beyond the first hundred records and omits an exact stale provider (#6501)", () => {
    const recorded = Object.freeze(
      Array.from({ length: 128 }, (_value, index) => `custom-provider-${index}`),
    );
    const responses = new Map<string, ProbeResult>([
      [
        "custom-provider-127",
        { status: 1, stderr: "Error: provider 'custom-provider-127' not found" },
      ],
    ]);
    const calls: Array<{ args: string[]; options: Record<string, unknown> | undefined }> = [];
    const runOpenshell = vi.fn((args: string[], options?: Record<string, unknown>): ProbeResult => {
      calls.push({ args, options });
      return responses.get(args.at(-1) ?? "") ?? { status: 0, stdout: "" };
    });

    const reconciled = reconcileRegisteredExtraProviders("nemoclaw", {
      listExtraProviders: () => [...recorded],
      runOpenshell,
    });

    expect(reconciled).toEqual(recorded.slice(0, -1));
    expect(calls).toHaveLength(recorded.length);
    expect(calls.every(({ args }) => args[0] === "provider" && args[1] === "get")).toBe(true);
    expect(calls.some(({ args }) => args.includes("list") || args.includes("--names"))).toBe(false);
    expect(calls[0]).toEqual({
      args: ["provider", "get", "-g", "nemoclaw", "custom-provider-0"],
      options: {
        ignoreError: true,
        maxBuffer: 64 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        suppressOutput: true,
        timeout: 5_000,
      },
    });
  });

  it("keeps healthy custom providers even when successful get output is empty (#6501)", () => {
    const recorded = Object.freeze(["custom-provider", "my-slack-bridge"]);
    const runOpenshell = vi.fn((): ProbeResult => ({ status: 0, stdout: "", stderr: "" }));

    const reconciled = reconcileRegisteredExtraProviders("nemoclaw", {
      listExtraProviders: () => [...recorded],
      runOpenshell,
    });

    expect(reconciled).toEqual(recorded);
    expect(recorded).toEqual(["custom-provider", "my-slack-bridge"]);
    expect(runOpenshell).toHaveBeenCalledTimes(2);
  });

  it("omits only the entry with an exact provider-specific not-found diagnostic (#6501)", () => {
    const recorded = Object.freeze([
      "healthy-provider",
      "stale-provider",
      "indeterminate-provider",
    ]);
    const responses = new Map<string, ProbeResult>([
      [
        "stale-provider",
        {
          status: 1,
          stderr: Buffer.from("Error: provider 'stale-provider' not found\n"),
        },
      ],
      [
        "indeterminate-provider",
        { status: 1, stderr: "Error: provider 'some-other-provider' not found" },
      ],
    ]);
    const runOpenshell = vi.fn((args: string[]): ProbeResult => {
      return responses.get(args.at(-1) ?? "") ?? { status: 0 };
    });

    const reconciled = reconcileRegisteredExtraProviders("nemoclaw", {
      listExtraProviders: () => [...recorded],
      runOpenshell,
    });

    expect(reconciled).toEqual(["healthy-provider", "indeterminate-provider"]);
    expect(recorded).toEqual(["healthy-provider", "stale-provider", "indeterminate-provider"]);
  });

  it("accepts the exact wrapped not-found diagnostic reported by OpenShell (#6501)", () => {
    const wrappedDiagnostic = Buffer.from(
      [
        "Error:   × provider 'tavily-search' not found and 'tavily-search' is not a recognized",
        "  │ provider type. Create it first with `openshell provider create --type",
        "  │ <type> --name tavily-search`",
      ].join("\n"),
    );
    const responses = new Map<string, ProbeResult>([
      [
        "tavily-search",
        {
          status: 1,
          stderr: wrappedDiagnostic,
          stdout: Buffer.alloc(0),
          output: [null, Buffer.alloc(0), wrappedDiagnostic],
        },
      ],
      [
        "mismatched-provider",
        {
          status: 1,
          stderr:
            "Error: × provider 'mismatched-provider' not found and 'other-provider' is not a recognized provider type. Create it first with `openshell provider create --type <type> --name mismatched-provider`",
        },
      ],
      [
        "spoofed-command-provider",
        {
          status: 1,
          stderr:
            "Error: × provider 'spoofed-command-provider' not found and 'spoofed-command-provider' is not a recognized provider type. Create it first with `openshell provider create --type <type> --name other-provider`",
        },
      ],
    ]);
    const runOpenshell = vi.fn((args: string[]): ProbeResult => {
      return responses.get(args.at(-1) ?? "") ?? { status: 0 };
    });

    expect(
      reconcileRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => [
          "tavily-search",
          "mismatched-provider",
          "spoofed-command-provider",
        ],
        runOpenshell,
      }),
    ).toEqual(["mismatched-provider", "spoofed-command-provider"]);
  });

  it("uses the composite spawn output only when stderr and stdout are empty (#6501)", () => {
    const diagnostic = Buffer.from("Error: provider 'stale-provider' not found");
    const runOpenshell = vi.fn(
      (): ProbeResult => ({
        status: 1,
        output: [null, Buffer.alloc(0), diagnostic],
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(0),
      }),
    );

    expect(
      reconcileRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => ["stale-provider"],
        runOpenshell,
      }),
    ).toEqual([]);
  });

  it("fails open when a diagnostic stream reaches the capture limit (#6501)", () => {
    const truncated = Buffer.from(
      "Error: provider 'stale-provider' not found".padEnd(64 * 1024, " "),
    );
    const runOpenshell = vi.fn((): ProbeResult => ({ status: 1, stderr: truncated }));

    expect(
      reconcileRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => ["stale-provider"],
        runOpenshell,
      }),
    ).toEqual(["stale-provider"]);
  });

  it("accepts the exact gRPC not-found ordering without using broad name heuristics (#6501)", () => {
    const runOpenshell = vi.fn(
      (): ProbeResult => ({
        status: 1,
        stderr: 'rpc error: NotFound: provider "stale-provider"',
      }),
    );

    expect(
      reconcileRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => ["stale-provider"],
        runOpenshell,
      }),
    ).toEqual([]);
  });

  it("compares captured names byte-for-byte while matching keywords case-insensitively (#6501)", () => {
    const responses = new Map<string, ProbeResult>([
      ["ProviderA", { status: 1, stderr: "Error: provider 'providera' not found" }],
      ["ProviderB", { status: 1, stderr: "ERROR: PROVIDER 'ProviderB' NOT FOUND" }],
    ]);
    const runOpenshell = vi.fn((args: string[]): ProbeResult => {
      return responses.get(args.at(-1) ?? "") ?? { status: 0 };
    });

    expect(
      reconcileRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => ["ProviderA", "ProviderB"],
        runOpenshell,
      }),
    ).toEqual(["ProviderA"]);
  });

  it("preserves providers when a missing-gateway diagnostic merely mentions them (#6501)", () => {
    const diagnostics = [
      "Error: gateway 'nemoclaw' not found while checking provider 'custom-provider'",
      "Error: gateway not found: provider 'custom-provider' was requested",
      'Error: status: NotFound, message: "gateway not found"; requested provider "custom-provider"',
      "Error: gateway 'nemoclaw' not found; provider 'custom-provider' not found during lookup",
      "Unknown gateway 'nemoclaw' while checking provider 'custom-provider'",
      "No such gateway 'nemoclaw'; provider 'custom-provider' not found",
      "Transport closed while checking provider 'custom-provider' not found",
      "transport error\nError: provider 'custom-provider' not found",
      "authentication failed\nError: provider 'custom-provider' not found",
    ];

    for (const diagnostic of diagnostics) {
      const runOpenshell = vi.fn((): ProbeResult => ({ status: 1, stderr: diagnostic }));
      expect(
        reconcileRegisteredExtraProviders("nemoclaw", {
          listExtraProviders: () => ["custom-provider"],
          runOpenshell,
        }),
        diagnostic,
      ).toEqual(["custom-provider"]);
    }
  });

  it("fails open for thrown, timed-out, and otherwise ambiguous probes (#6501)", () => {
    const runOpenshell = vi.fn((args: string[]): ProbeResult => {
      switch (args.at(-1)) {
        case "thrown-provider":
          throw new Error("gateway process unavailable");
        case "timed-out-provider":
          return {
            status: null,
            stderr: "operation timed out: provider 'timed-out-provider' not found",
          };
        case "nonstandard-exit-provider":
          return {
            status: 7,
            stderr: "provider 'nonstandard-exit-provider' not found",
          };
        case "buffer-error-provider":
          return {
            status: 1,
            error: new Error("spawnSync ENOBUFS"),
            stderr: "provider 'buffer-error-provider' not found",
          };
        case "ambiguous-provider":
          return { status: 1, stderr: "provider lookup failed" };
        case "unavailable-provider":
          return {
            status: 1,
            stderr:
              "Error: status: Unavailable, message: \"provider 'unavailable-provider' not found\"",
          };
        default:
          return { status: 0 };
      }
    });
    const recorded = [
      "thrown-provider",
      "timed-out-provider",
      "nonstandard-exit-provider",
      "buffer-error-provider",
      "ambiguous-provider",
      "unavailable-provider",
    ];

    expect(
      reconcileRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => [...recorded],
        runOpenshell,
      }),
    ).toEqual(recorded);
  });

  it("bounds aggregate probe latency and preserves names left after the deadline (#6501)", () => {
    let now = 0;
    const timeouts: number[] = [];
    const runOpenshell = vi.fn(
      (_args: string[], options?: Record<string, unknown>): ProbeResult => {
        const timeout = Number(options?.timeout);
        timeouts.push(timeout);
        now += timeout;
        return { status: null, stderr: "provider process timed out" };
      },
    );
    const recorded = ["provider-1", "provider-2", "provider-3", "provider-4", "provider-5"];

    expect(
      reconcileRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => [...recorded],
        nowMs: () => now,
        runOpenshell,
      }),
    ).toEqual(recorded);
    expect(runOpenshell).toHaveBeenCalledTimes(3);
    expect(timeouts).toEqual([5_000, 5_000, 5_000]);
  });

  it("enforces gateway containment before making any nonempty provider probe (#6501)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://other.example.test");
    const runOpenshell = vi.fn((): ProbeResult => ({ status: 0 }));

    expect(() =>
      reconcileRegisteredExtraProviders("nemoclaw", {
        listExtraProviders: () => ["custom-provider"],
        runOpenshell,
      }),
    ).toThrow(/OPENSHELL_GATEWAY_ENDPOINT is set/);
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("requires a gateway name when recorded providers need reconciliation (#6501)", () => {
    const runOpenshell = vi.fn((): ProbeResult => ({ status: 0 }));

    expect(() =>
      reconcileRegisteredExtraProviders("", {
        listExtraProviders: () => ["custom-provider"],
        runOpenshell,
      }),
    ).toThrow("OpenShell gateway name is required.");
    expect(runOpenshell).not.toHaveBeenCalled();
  });
});
