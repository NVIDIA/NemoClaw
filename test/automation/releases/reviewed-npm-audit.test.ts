// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AuditExceptionRegistry,
  NPM_AUDIT_ARGV,
  NPM_AUDIT_ATTEMPT_TIMEOUT_MS,
  NPM_AUDIT_CACHE_FUTURE_SKEW_MS,
  NPM_AUDIT_CACHE_MAX_AGE_MS,
  assertExceptionGraphs,
  buildAuditCacheInput,
  buildAuditProvenance,
  deriveAuditEndpoints,
  evaluateAuditPolicy,
  exceedsAuditThreshold,
  extractAdvisoryIds,
  parseAuditExceptionRegistry,
  npmAuditProcessOptions,
  parseAuditReport,
  provenanceSidecarPath,
  readAuditCache,
  readAuditExceptionRegistry,
  runNpmAuditWithRetry,
  runReviewedNpmAudit,
  vulnerabilityCounts,
} from "../../../scripts/lib/reviewed-npm-audit.mts";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");
const CONFIG = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "ci", "reviewed-npm-audit.json"), "utf-8"),
) as {
  severityThreshold: "info" | "low" | "moderate" | "high" | "critical";
};
const CHECKED_IN_POLICY = parseAuditExceptionRegistry(
  fs.readFileSync(path.join(REPO_ROOT, "ci", "npm-audit-exceptions.json"), "utf-8"),
);
const EMPTY_POLICY: AuditExceptionRegistry = { schemaVersion: 1, exceptions: [] };
const NOW = new Date("2026-07-21T12:00:00Z");

function withInstalledGraph(
  packages: Readonly<Record<string, string>>,
  run: (directory: string) => void,
): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-audit-test-"));
  try {
    for (const [name, version] of Object.entries(packages)) {
      const packageDirectory = path.join(directory, "node_modules", ...name.split("/"));
      fs.mkdirSync(packageDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(packageDirectory, "package.json"),
        `${JSON.stringify({ name, version })}\n`,
      );
    }
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function highFindingReport(advisory = "GHSA-aaaa-bbbb-cccc") {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      parent: {
        name: "parent",
        severity: "high",
        isDirect: true,
        via: ["vulnerable-package"],
        effects: [],
        nodes: ["node_modules/parent"],
      },
      "vulnerable-package": {
        name: "vulnerable-package",
        severity: "high",
        isDirect: false,
        via: [
          {
            source: 123456,
            name: "vulnerable-package",
            dependency: "vulnerable-package",
            title: "test advisory",
            url: `https://github.com/advisories/${advisory}`,
            severity: "high",
            range: "<=1.0.0",
          },
        ],
        effects: ["parent"],
        nodes: ["node_modules/vulnerable-package"],
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0 },
    },
  };
}

function exceptionPolicy(
  overrides: Readonly<Record<string, unknown>> = {},
): AuditExceptionRegistry {
  return parseAuditExceptionRegistry(
    JSON.stringify({
      schemaVersion: 1,
      exceptions: [
        {
          advisory: "GHSA-aaaa-bbbb-cccc",
          package: "vulnerable-package",
          installedVersion: "1.0.0",
          graph: "test-graph",
          severity: "high",
          decision: "temporary-risk-acceptance",
          expires: "2026-07-28",
          owner: "security-maintainers",
          trackingIssue: "https://github.com/NVIDIA/NemoClaw/issues/1234",
          rationale: "The fix is in validation.",
          compensatingControls: ["The vulnerable input is rejected before this package runs."],
          ...overrides,
        },
      ],
    }),
    NOW,
  );
}

describe("reviewed npm audit gate", () => {
  it("removes the checked-in brace-expansion exception after remediation (#8116)", () => {
    expect(CHECKED_IN_POLICY).toEqual(EMPTY_POLICY);
  });

  it("fails at high or critical findings while retaining lower severities", () => {
    const report = {
      metadata: {
        vulnerabilities: { info: 3, low: 2, moderate: 1, high: 4, critical: 5 },
      },
    };
    const counts = vulnerabilityCounts(report);
    expect(exceedsAuditThreshold(counts, CONFIG.severityThreshold)).toBe(9);
    expect(exceedsAuditThreshold(counts, "critical")).toBe(5);
  });

  it("accepts npm's nonzero audit status when a complete finding report explains it", () => {
    const report = {
      metadata: {
        vulnerabilities: { info: 0, low: 1, moderate: 0, high: 0, critical: 0 },
      },
    };
    expect(parseAuditReport({ status: 1, stderr: "", stdout: JSON.stringify(report) })).toEqual(
      report,
    );
  });

  it("rejects a parseable npm transport failure instead of treating it as clean", () => {
    expect(() =>
      parseAuditReport({
        status: 1,
        stderr: "npm registry unavailable",
        stdout: JSON.stringify({
          error: { code: "ECONNREFUSED", summary: "request to registry failed" },
        }),
      }),
    ).toThrow(/ECONNREFUSED/);
  });

  it.each([
    ["missing metadata", {}],
    [
      "invalid severity count",
      { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: "0", critical: 0 } } },
    ],
  ])("rejects %s", (_label, report) => {
    expect(() =>
      parseAuditReport({ status: 0, stderr: "", stdout: JSON.stringify(report) }),
    ).toThrow(/vulnerability report|vulnerability count/);
  });

  it("retries scan-incomplete npm responses with bounded backoff", () => {
    const completeReport = {
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
      },
    };
    const sensitiveStderr =
      "request failed for https://audit-user:secret-token@registry.example/\n\u001b[31mstderr detail";
    const responses = [
      { status: 1, stderr: sensitiveStderr, stdout: "" },
      { status: 0, stderr: "", stdout: JSON.stringify(completeReport) },
    ];
    const delays: number[] = [];
    const warnings: string[] = [];
    let attempt = 0;

    const audit = runNpmAuditWithRetry({
      run: () => responses[attempt++] as (typeof responses)[number],
      wait: (delayMs) => delays.push(delayMs),
      warn: (message) => warnings.push(message),
    });

    expect(attempt).toBe(2);
    expect(delays).toEqual([1_000]);
    expect(warnings).toEqual([
      "npm audit scan incomplete on attempt 1/2; retrying in 1000 ms (reason=empty-output)",
    ]);
    const warningOutput = warnings.join("\n");
    expect(warningOutput).not.toContain("audit-user");
    expect(warningOutput).not.toContain("secret-token");
    expect(warningOutput).not.toContain("registry.example");
    expect(warningOutput).not.toContain("\u001b");
    expect(audit.failure).toBeUndefined();
    expect(audit.report).toEqual(completeReport);
    expect(audit.result).toEqual(responses[1]);
  });

  it("does not retry a complete blocking vulnerability report", () => {
    let attempts = 0;
    const report = highFindingReport();

    const audit = runNpmAuditWithRetry({
      run: () => {
        attempts += 1;
        return { status: 1, stderr: "", stdout: JSON.stringify(report) };
      },
      wait: () => {
        throw new Error("complete reports must not back off");
      },
      warn: () => {
        throw new Error("complete reports must not emit retry warnings");
      },
    });

    expect(attempts).toBe(1);
    expect(audit.failure).toBeUndefined();
    expect(audit.report).toEqual(report);
    withInstalledGraph({ parent: "2.0.0", "vulnerable-package": "1.0.0" }, (directory) => {
      expect(
        evaluateAuditPolicy({
          directory,
          exceptionPolicy: EMPTY_POLICY,
          exceptionPolicySha256: "a".repeat(64),
          graph: "test-graph",
          report,
          threshold: "high",
        }).status,
      ).toBe("blocked");
    });
  });

  it("gives each audit process ten minutes to complete", () => {
    expect(NPM_AUDIT_ATTEMPT_TIMEOUT_MS).toBe(600_000);
    expect(npmAuditProcessOptions("/tmp/audit-graph")).toMatchObject({
      cwd: "/tmp/audit-graph",
      timeout: 600_000,
    });
  });

  it("retries a timed-out scanner process within the same budget", () => {
    const delays: number[] = [];
    const timeoutResult = {
      error: Object.assign(new Error("spawnSync npm ETIMEDOUT"), { code: "ETIMEDOUT" }),
      status: null,
      stderr: "",
      stdout: "",
    };
    const completeResult = {
      status: 0,
      stderr: "",
      stdout: JSON.stringify({
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
        },
      }),
    };
    const responses = [timeoutResult, completeResult];
    let attempts = 0;

    const audit = runNpmAuditWithRetry({
      run: () => responses[attempts++]!,
      wait: (delayMs) => delays.push(delayMs),
      warn: () => {},
    });

    expect(attempts).toBe(2);
    expect(delays).toEqual([1_000]);
    expect(audit.failure).toBeUndefined();
  });

  it("does not retry non-timeout scanner spawn errors", () => {
    const waits: number[] = [];
    const warnings: string[] = [];
    const spawnError = Object.assign(new Error("spawnSync npm ENOENT"), { code: "ENOENT" });
    let attempts = 0;

    expect(() =>
      runNpmAuditWithRetry({
        run: () => {
          attempts += 1;
          return {
            error: spawnError,
            status: null,
            stderr: "npm was not found",
            stdout: "",
          };
        },
        wait: (delayMs) => waits.push(delayMs),
        warn: (message) => warnings.push(message),
      }),
    ).toThrow("spawnSync npm ENOENT");

    expect(attempts).toBe(1);
    expect(waits).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("fails closed after the scan-incomplete retry budget is exhausted", () => {
    const delays: number[] = [];
    let attempts = 0;

    const audit = runNpmAuditWithRetry({
      run: () => {
        attempts += 1;
        return {
          status: 1,
          stderr: "registry-token=terminal-stderr-secret",
          stdout: JSON.stringify({
            error: {
              summary: "registry-token=terminal-summary-secret",
              detail: "authorization: bearer terminal-detail-secret",
            },
          }),
        };
      },
      wait: (delayMs) => delays.push(delayMs),
      warn: () => {},
    });

    expect(attempts).toBe(2);
    expect(delays).toEqual([1_000]);
    expect(audit.report).toBeUndefined();
    expect(audit.failure?.message).toBe(
      "npm audit scan remained incomplete after 2 attempts (reason=incomplete-report)",
    );
    expect(audit.failure?.message).not.toContain("terminal-stderr-secret");
    expect(audit.failure?.message).not.toContain("terminal-summary-secret");
    expect(audit.failure?.message).not.toContain("terminal-detail-secret");
  });

  it("accepts one exact blocking advisory and its propagated meta-vulnerability", () => {
    withInstalledGraph({ parent: "2.0.0", "vulnerable-package": "1.0.0" }, (directory) => {
      const result = evaluateAuditPolicy({
        directory,
        exceptionPolicy: exceptionPolicy(),
        exceptionPolicySha256: "a".repeat(64),
        graph: "test-graph",
        report: highFindingReport(),
        threshold: "high",
      });
      expect(result.status).toBe("accepted-exceptions");
      expect(result.acceptedAdvisories).toEqual(["GHSA-aaaa-bbbb-cccc"]);
      expect(result.unacceptedBlockingAdvisories).toEqual([]);
    });
  });

  it("does not let one exception suppress another blocking advisory", () => {
    withInstalledGraph(
      { parent: "2.0.0", "other-package": "3.0.0", "vulnerable-package": "1.0.0" },
      (directory) => {
        const report = highFindingReport() as Record<string, unknown>;
        const vulnerabilities = report.vulnerabilities as Record<string, unknown>;
        vulnerabilities["other-package"] = {
          name: "other-package",
          severity: "high",
          isDirect: false,
          via: [
            {
              source: 654321,
              name: "other-package",
              dependency: "other-package",
              title: "another advisory",
              url: "https://github.com/advisories/GHSA-dddd-eeee-ffff",
              severity: "high",
              range: "<=3.0.0",
            },
          ],
          effects: [],
          nodes: ["node_modules/other-package"],
        };
        const metadata = report.metadata as {
          vulnerabilities: { high: number };
        };
        metadata.vulnerabilities.high = 3;
        const result = evaluateAuditPolicy({
          directory,
          exceptionPolicy: exceptionPolicy(),
          exceptionPolicySha256: "a".repeat(64),
          graph: "test-graph",
          report,
          threshold: "high",
        });
        expect(result.status).toBe("blocked");
        expect(result.unacceptedBlockingAdvisories).toEqual([
          {
            advisory: "GHSA-dddd-eeee-ffff",
            installedVersion: "3.0.0",
            package: "other-package",
            severity: "high",
          },
        ]);
      },
    );
  });

  it("rejects an exception that does not match a reported finding", () => {
    withInstalledGraph({ parent: "2.0.0", "vulnerable-package": "1.0.0" }, (directory) => {
      expect(() =>
        evaluateAuditPolicy({
          directory,
          exceptionPolicy: exceptionPolicy({ installedVersion: "1.0.1" }),
          exceptionPolicySha256: "a".repeat(64),
          graph: "test-graph",
          report: highFindingReport(),
          threshold: "high",
        }),
      ).toThrow(/unused npm audit exceptions/);
    });
  });

  it("rejects exception graph IDs outside the configured production inventory", () => {
    expect(() => assertExceptionGraphs(exceptionPolicy(), new Set(["production-graph"]))).toThrow(
      /unknown graphs: test-graph/,
    );
  });

  it.each([
    ["expired", { expires: "2026-07-20" }, /expired/],
    ["invalid date", { expires: "2026-02-31" }, /YYYY-MM-DD/],
    ["overlong", { expires: "2026-09-01" }, /within 30 days/],
    ["unknown field", { extra: true }, /unknown fields/],
    ["missing controls", { compensatingControls: undefined }, /compensatingControls is required/],
    ["foreign issue", { trackingIssue: "https://github.com/example/project/issues/1" }, /NemoClaw/],
  ])("rejects an %s exception", (_label, overrides, message) => {
    expect(() => exceptionPolicy(overrides)).toThrow(message);
  });

  it("rejects a missing exception registry instead of treating it as empty", () => {
    expect(() => readAuditExceptionRegistry(path.join(REPO_ROOT, "ci", "missing.json"))).toThrow(
      /ENOENT/,
    );
  });
});

describe("reviewed npm audit raw cache", () => {
  function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-audit-cache-"));
    fs.writeFileSync(path.join(directory, "package.json"), '{"name":"fixture"}\n');
    fs.writeFileSync(path.join(directory, "package-lock.json"), '{"lockfileVersion":3}\n');
    return directory;
  }

  it("replays an exact fresh raw result and reports cache evidence (#11028)", () => {
    const directory = fixture();
    try {
      const input = buildAuditCacheInput(
        directory,
        "10.9.7",
        "https://user:secret@registry.npmjs.org/private/path?token=query#fragment",
      );
      const filename = path.join(directory, "cache.json");
      const stdout = JSON.stringify({
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
      });
      fs.writeFileSync(
        filename,
        JSON.stringify({
          schemaVersion: 1,
          createdAt: "2026-07-21T11:00:00.000Z",
          input,
          result: { stdout, exitCode: 0 },
        }),
      );
      const hit = readAuditCache(filename, input, NOW);
      expect(hit?.result.stdout).toBe(stdout);
      expect(hit?.evidence).toMatchObject({ origin: "cache", ageMs: 3_600_000 });
      expect(input.argv).toEqual(NPM_AUDIT_ARGV);
      expect(input.registryOrigin).toBe("https://registry.npmjs.org/");
      expect(JSON.stringify(input)).not.toContain("secret");
      expect(JSON.stringify(input)).not.toContain("private");
      expect(JSON.stringify(input)).not.toContain("query");
      expect(hit?.evidence.inputSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(hit?.evidence.responseSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["stale", -NPM_AUDIT_CACHE_MAX_AGE_MS],
    ["too far in the future", NPM_AUDIT_CACHE_FUTURE_SKEW_MS + 1],
  ])("rejects a %s record", (_label, createdOffset) => {
    const directory = fixture();
    try {
      const input = buildAuditCacheInput(directory, "10.9.7", "https://registry.npmjs.org/");
      const filename = path.join(directory, "cache.json");
      fs.writeFileSync(
        filename,
        JSON.stringify({
          schemaVersion: 1,
          createdAt: new Date(NOW.valueOf() + createdOffset).toISOString(),
          input,
          result: { stdout: "{}", exitCode: 0 },
        }),
      );
      expect(readAuditCache(filename, input, NOW)).toBeNull();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed, extra-field, and input-mismatched records", () => {
    const directory = fixture();
    try {
      const input = buildAuditCacheInput(directory, "10.9.7", "https://registry.npmjs.org/");
      const filename = path.join(directory, "cache.json");
      fs.writeFileSync(filename, "not json");
      expect(readAuditCache(filename, input, NOW)).toBeNull();
      fs.writeFileSync(
        filename,
        JSON.stringify({
          schemaVersion: 1,
          createdAt: NOW.toISOString(),
          input,
          result: { stdout: "{}", exitCode: 0 },
          poison: process.env,
        }),
      );
      expect(readAuditCache(filename, input, NOW)).toBeNull();
      const changed = { ...input, npmVersion: "11.0.0" };
      fs.writeFileSync(
        filename,
        JSON.stringify({
          schemaVersion: 1,
          createdAt: NOW.toISOString(),
          input,
          result: { stdout: "{}", exitCode: 0 },
        }),
      );
      expect(readAuditCache(filename, changed, NOW)).toBeNull();
      fs.writeFileSync(path.join(directory, "package.json"), '{"name":"changed"}\n');
      expect(buildAuditCacheInput(directory, "10.9.7", "https://registry.npmjs.org/")).not.toEqual(
        input,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("reviewed npm audit provenance", () => {
  const detectionReport = {
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 },
    },
    vulnerabilities: {
      "fast-uri": {
        via: [
          {
            source: 1104001,
            name: "fast-uri",
            url: "https://github.com/advisories/GHSA-4c8g-83qw-93j6",
          },
          "ajv",
        ],
      },
      ajv: { via: ["fast-uri"] },
      tar: {
        via: [
          { url: "https://github.com/advisories/GHSA-23hp-3jrh-7fpw" },
          { url: "https://github.com/advisories/GHSA-4c8g-83qw-93j6" },
        ],
      },
    },
  };

  it("extracts sorted unique GHSA ids from a report", () => {
    expect(extractAdvisoryIds(detectionReport)).toEqual([
      "GHSA-23hp-3jrh-7fpw",
      "GHSA-4c8g-83qw-93j6",
    ]);
  });

  it.each([
    ["a clean report", { metadata: { vulnerabilities: {} } }],
    ["a report without vulnerabilities", {}],
    ["string-only via chains", { vulnerabilities: { ajv: { via: ["fast-uri"] } } }],
    ["a malformed vulnerabilities value", { vulnerabilities: [1, 2] }],
  ])("extracts no advisory ids from %s", (_label, report) => {
    expect(extractAdvisoryIds(report as Record<string, unknown>)).toEqual([]);
  });

  it.each(["https://registry.npmjs.org/", "https://registry.npmjs.org"])(
    "derives the bulk advisory endpoint npm audit uses from %s",
    (registry) => {
      const endpoints = deriveAuditEndpoints(registry);
      expect(endpoints).toEqual({
        configuredRegistry: "https://registry.npmjs.org/",
        bulkAdvisoryEndpoint: "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
        note: expect.stringMatching(/bulk advisory endpoint.*no advisory data/s),
      });
    },
  );

  it("redacts registry URL credentials from retained provenance", () => {
    expect(deriveAuditEndpoints("https://audit-user:audit-token@registry.npmjs.org/")).toEqual({
      configuredRegistry: "https://registry.npmjs.org/",
      bulkAdvisoryEndpoint: "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
      note: expect.stringMatching(/bulk advisory endpoint.*no advisory data/s),
    });
  });

  it("places the provenance sidecar next to its raw report", () => {
    expect(provenanceSidecarPath("/tmp/artifacts/reviewed-archive-graph.json")).toBe(
      "/tmp/artifacts/reviewed-archive-graph.provenance.json",
    );
  });

  it("builds a complete provenance record for one audited graph", () => {
    const provenance = buildAuditProvenance({
      finishedAt: "2026-07-21T20:09:41.000Z",
      label: "reviewed archive graph",
      nodeVersion: "v22.22.2",
      npmVersion: "10.9.7",
      packageSpecs: ["openclaw@2026.6.10", "@openclaw/slack@2026.6.10"],
      rawReportPath: "reviewed-archive-graph.json",
      registry: "https://registry.npmjs.org/",
      report: detectionReport,
      startedAt: "2026-07-21T20:09:12.000Z",
    });
    expect(provenance).toEqual({
      schemaVersion: 1,
      scanner: { name: "npm audit", npmVersion: "10.9.7", nodeVersion: "v22.22.2" },
      registry: deriveAuditEndpoints("https://registry.npmjs.org/"),
      run: { startedAt: "2026-07-21T20:09:12.000Z", finishedAt: "2026-07-21T20:09:41.000Z" },
      graph: {
        label: "reviewed archive graph",
        packageSpecs: ["openclaw@2026.6.10", "@openclaw/slack@2026.6.10"],
      },
      rawReportPath: "reviewed-archive-graph.json",
      advisoryIds: ["GHSA-23hp-3jrh-7fpw", "GHSA-4c8g-83qw-93j6"],
    });
    expect(provenance).not.toHaveProperty("failure");
  });

  it("records a failure marker so a failed audit attempt still leaves provenance", () => {
    const provenance = buildAuditProvenance({
      failure: "npm audit failed without vulnerability findings: ECONNREFUSED",
      finishedAt: "2026-07-21T20:09:41.000Z",
      label: "reviewed archive graph",
      nodeVersion: "v22.22.2",
      npmVersion: "10.9.7",
      packageSpecs: ["openclaw@2026.6.10"],
      rawReportPath: "reviewed-archive-graph.json",
      registry: "https://registry.npmjs.org/",
      report: {},
      startedAt: "2026-07-21T20:09:12.000Z",
    });
    expect(provenance.failure).toBe(
      "npm audit failed without vulnerability findings: ECONNREFUSED",
    );
    expect(provenance.advisoryIds).toEqual([]);
  });

  it.each(["", "   "])(
    "records an unknown registry explicitly instead of deriving a nonsense endpoint (%j)",
    (registry) => {
      expect(deriveAuditEndpoints(registry)).toEqual({
        configuredRegistry: null,
        bulkAdvisoryEndpoint: null,
        note: expect.stringMatching(/registry could not be safely recorded/),
      });
    },
  );

  it("writes the failure sidecar before rethrowing when npm audit hard-fails", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-audit-provenance-"));
    const originalPath = process.env.PATH;
    try {
      const fakeBin = path.join(tempRoot, "bin");
      const exceptionFile = path.join(tempRoot, "exceptions.json");
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(exceptionFile, `${JSON.stringify({ schemaVersion: 1, exceptions: [] })}\n`);
      // Fake npm: `npm audit` emits npm's parseable transport-error JSON and
      // exits 1; every other subcommand (registry introspection) fails hard.
      fs.writeFileSync(
        path.join(fakeBin, "npm"),
        [
          "#!/bin/sh",
          'test "$1" = "audit" && {',
          '  echo \'{"error":{"code":"ECONNREFUSED","summary":"registry unreachable"}}\'',
          "  exit 1",
          "}",
          "exit 7",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
      const reportPath = path.join(tempRoot, "graph.json");
      expect(() =>
        runReviewedNpmAudit({
          directory: tempRoot,
          exceptionFile,
          graph: "fixture-graph",
          provenance: {
            label: "fixture graph",
            nodeVersion: "v22.22.2",
            npmVersion: "10.9.7",
            packageSpecs: ["fixture@1.0.0"],
          },
          reportFile: reportPath,
          threshold: "high",
        }),
      ).toThrow("npm audit scan remained incomplete after 2 attempts (reason=incomplete-report)");
      const sidecar = JSON.parse(
        fs.readFileSync(path.join(tempRoot, "graph.provenance.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(sidecar.failure).toBe(
        "npm audit scan remained incomplete after 2 attempts (reason=incomplete-report)",
      );
      expect(sidecar.failure).not.toContain("ECONNREFUSED");
      expect(sidecar.failure).not.toContain("registry unreachable");
      expect(sidecar.advisoryIds).toEqual([]);
      expect(sidecar.rawReportPath).toBe("graph.json");
      expect(sidecar.registry).toEqual(deriveAuditEndpoints("https://registry.yarnpkg.com"));
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
