// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { LIMIT, reconcile } from "./extra-provider-reconciliation.test-fixtures";

const exactWrappedDiagnostic = [
  "Error:   × provider 'stale-provider' not found and 'stale-provider' is not a recognized",
  "  │ provider type. Create it first with `openshell provider create --type",
  "  │ <type> --name stale-provider`",
].join("\n");

describe("reconcileRegisteredExtraProviders diagnostics", () => {
  it.each([
    {
      label: "single-quoted CLI",
      provider: "stale-provider",
      stderr: "Error: provider 'stale-provider' not found",
    },
    {
      label: "double-quoted gRPC",
      provider: "stale-provider",
      stderr: 'rpc error: NotFound: provider "stale-provider"',
    },
    {
      label: "wrapped OpenShell issue diagnostic",
      provider: "stale-provider",
      stderr: exactWrappedDiagnostic,
    },
    {
      label: "wrapped OpenShell issue diagnostic with split provider token",
      provider: "e2e-stale-extra-provider",
      stderr: [
        "Error:   × provider 'e2e-stale-extra-provider' not found and 'e2e-stale-extra-",
        "  │ provider' is not a recognized provider type. Create it first with",
        "  │ `openshell provider create --type <type> --name e2e-stale-extra-provider`",
      ].join("\n"),
    },
    {
      label: "short OpenShell issue diagnostic",
      provider: "e2e-stale-extra-provider",
      stderr: "Error:   × provider 'e2e-stale-extra-provider' not found",
    },
    {
      label: "colored OpenShell issue diagnostic",
      provider: "colored-provider",
      stderr:
        "\u001b[1m\u001b[31mError:\u001b[39m\u001b[0m   × provider 'colored-provider' not found",
    },
    {
      label: "wrapped OpenShell provider-get issue diagnostic without a remediation command",
      provider: "e2e-stale-extra-provider",
      stderr: [
        "Error:   × provider 'e2e-stale-extra-provider' not found and 'e2e-stale-extra-",
        "  │ provider' is not a recognized provider type.",
      ].join("\n"),
    },
    {
      label: "wrapped OpenShell issue diagnostic with split remediation provider token",
      provider: "e2e-resume-stale-extra-provider",
      stderr: [
        "Error:   × provider 'e2e-resume-stale-extra-provider' not found and 'e2e-resume-",
        "  │ stale-extra-provider' is not a recognized provider type. Create it first",
        "  │ with `openshell provider create --type <type> --name e2e-resume-stale-",
        "  │ extra-provider`",
      ].join("\n"),
    },
    {
      label: "wrapped OpenShell provider-get issue diagnostic after runner prefix",
      provider: "e2e-stale-extra-provider",
      stderr: [
        "OpenShell command failed while probing provider:",
        "Error:   × provider 'e2e-stale-extra-provider' not found and 'e2e-stale-extra-",
        "  │ provider' is not a recognized provider type. Create it first with",
        "  │ `openshell provider create --type <type> --name e2e-stale-extra-provider`",
      ].join("\n"),
    },
    {
      label: "OpenShell issue diagnostic with structured not-found code and message",
      provider: "stale-provider",
      stderr:
        "Error:   × code: 'Some requested entity was not found', message: \"provider 'stale-provider' not found\"",
    },
    {
      label: "OpenShell provider-get generic not-found diagnostic",
      provider: "stale-provider",
      stderr:
        "Error:   × code: 'Some requested entity was not found', message: \"provider not found\"",
    },
    {
      label: "short targeted provider-get generic not-found diagnostic",
      provider: "stale-provider",
      stderr: "Error: provider not found",
    },
    {
      label: "provider name containing gateway",
      provider: "my-gateway-provider",
      stderr: "Error: provider 'my-gateway-provider' not found",
    },
  ])("accepts exact $label not-found diagnostics (#6501)", ({ provider, stderr }) => {
    expect(reconcile([provider], { [provider]: { status: 1, stderr } })).toEqual([]);
  });

  it.each([
    [
      "mismatched wrapped provider name",
      "Error: × provider 'stale-provider' not found and 'other-provider' is not a recognized provider type. Create it first with `openshell provider create --type <type> --name stale-provider`",
    ],
    [
      "mismatched wrapped create command name",
      "Error: × provider 'stale-provider' not found and 'stale-provider' is not a recognized provider type. Create it first with `openshell provider create --type <type> --name other-provider`",
    ],
    [
      "gateway missing",
      "Error: gateway 'nemoclaw' not found while checking provider 'stale-provider'",
    ],
    [
      "gateway and provider missing",
      "Error: gateway 'nemoclaw' not found; provider 'stale-provider' not found",
    ],
    [
      "structured not-found code but gateway message",
      "Error: × code: 'Some requested entity was not found', message: \"gateway 'nemoclaw' not found while checking provider 'stale-provider'\"",
    ],
    ["transport plus provider text", "transport error\nError: provider 'stale-provider' not found"],
    ["transport plus generic provider text", "transport error\nError: provider not found"],
    [
      "conflicting structured status",
      "Error: status: Unavailable, message: \"provider 'stale-provider' not found\"",
    ],
  ])("preserves providers for ambiguous diagnostics: %s (#6501)", (_label, stderr) => {
    expect(
      reconcile(["stale-provider"], {
        "stale-provider": { status: 1, stderr },
      }),
    ).toEqual(["stale-provider"]);
  });

  it("uses composite output only when stderr and stdout are empty (#6501)", () => {
    const diagnostic = Buffer.from("Error: provider 'stale-provider' not found");

    expect(
      reconcile(["stale-provider"], {
        "stale-provider": {
          status: 1,
          output: [null, Buffer.alloc(0), diagnostic],
          stderr: Buffer.alloc(0),
          stdout: Buffer.alloc(0),
        },
      }),
    ).toEqual([]);
  });

  it("bounds diagnostics before parsing and warns without leaking provider names (#6501)", () => {
    const warn = vi.fn();
    const recorded = ["at-limit-provider", "ambiguous-provider"];

    expect(
      reconcile(
        recorded,
        {
          "at-limit-provider": {
            status: 1,
            stderr: Buffer.from("Error: provider 'at-limit-provider' not found".padEnd(LIMIT, " ")),
          },
          "ambiguous-provider": {
            status: 1,
            stderr: `Error: provider '${"a".repeat(63 * 1024)}`,
          },
        },
        { warn },
      ),
    ).toEqual(recorded);
    expect(warn).toHaveBeenCalledWith(
      "  Warning: extra-provider reconciliation preserved indeterminate attachments " +
        "(providerCount=2; reasonClasses=ambiguous-diagnostic,diagnostic-capture-limit).",
    );
    expect(warn.mock.calls[0]?.[0]).not.toContain("at-limit-provider");
    expect(warn.mock.calls[0]?.[0]).not.toContain("ambiguous-provider");
  });

  it("redacts exact diagnostic provider names from warnings (#6501)", () => {
    const warn = vi.fn();

    expect(
      reconcile(
        ["exact-provider", "named-ambiguous-provider"],
        {
          "exact-provider": {
            status: 1,
            stderr: "Error: provider 'exact-provider' not found",
          },
          "named-ambiguous-provider": {
            status: 1,
            stderr:
              "Error: status: Unavailable, message: \"provider 'named-ambiguous-provider' not found\"",
          },
        },
        { warn },
      ),
    ).toEqual(["named-ambiguous-provider"]);
    expect(warn).toHaveBeenCalledWith(
      "  Warning: extra-provider reconciliation preserved indeterminate attachments " +
        "(providerCount=1; reasonClasses=ambiguous-diagnostic).",
    );
    expect(warn.mock.calls[0]?.[0]).not.toContain("exact-provider");
    expect(warn.mock.calls[0]?.[0]).not.toContain("named-ambiguous-provider");
  });

  it("keeps branch priority deterministic for conflicting diagnostics (#6501)", () => {
    expect(
      reconcile(["stale-provider"], {
        "stale-provider": {
          status: 1,
          stderr: [
            "Error: gateway 'nemoclaw' not found",
            "Error: provider 'stale-provider' not found",
          ].join("\n"),
        },
      }),
    ).toEqual(["stale-provider"]);
    expect(
      reconcile(["stale-provider"], {
        "stale-provider": {
          status: 1,
          stderr: [
            "Error: code: Unavailable",
            'rpc error: NotFound: provider "stale-provider"',
          ].join("\n"),
        },
      }),
    ).toEqual(["stale-provider"]);
  });

  it("preserves providers when the not-found diagnostic uses different casing (#6501)", () => {
    expect(
      reconcile(["tavily-search"], {
        "tavily-search": {
          status: 1,
          stderr: "Error: provider 'Tavily-Search' not found",
        },
      }),
    ).toEqual(["tavily-search"]);
  });

  it("parses adversarial diagnostics within a bounded budget (#6501)", () => {
    const adversarial = [
      `${"error: ".repeat(2_000)}provider 'redos-provider' not found`,
      `Error: provider '${"a".repeat(8_000)}`,
      `${"gateway ".repeat(1_000)}provider 'redos-provider' not found`,
      `status: unavailable ${"provider 'redos-provider' not found ".repeat(1_000)}`,
    ].join("\n");
    const started = performance.now();

    expect(
      reconcile(["redos-provider"], {
        "redos-provider": { status: 1, stderr: adversarial },
      }),
    ).toEqual(["redos-provider"]);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
