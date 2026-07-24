// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { correlateAdvisories } from "../scripts/lib/advisory-early-warning.mts";
import {
  attachNvdReconciliations,
  deriveCveId,
  type NvdRecord,
  parseNvdRecord,
  reconcileSignalWithNvd,
} from "../scripts/lib/nvd-reconciliation.mts";

// NVD 2.0 API response (GET services.nvd.nist.gov/rest/json/cves/2.0?cveId=...)
// modeled on the fast-uri advisory from the #7276 evidence table: analyzed by
// NVD with CPE applicability criteria. NVD timestamps carry no timezone
// designator. Only the cpeMatch entry flagged vulnerable names the vulnerable
// product; the second entry is platform context and must not be collected.
const analyzedFastUriResponse = {
  resultsPerPage: 1,
  startIndex: 0,
  totalResults: 1,
  format: "NVD_CVE",
  version: "2.0",
  timestamp: "2026-07-22T09:15:04.113",
  vulnerabilities: [
    {
      cve: {
        id: "CVE-2026-13676",
        sourceIdentifier: "security-advisories@github.com",
        published: "2026-06-29T16:15:09.230",
        lastModified: "2026-07-08T14:02:33.410",
        vulnStatus: "Analyzed",
        descriptions: [
          { lang: "en", value: "fast-uri URI parsing divergence enables authority spoofing." },
        ],
        metrics: {
          cvssMetricV31: [
            {
              source: "nvd@nist.gov",
              type: "Primary",
              cvssData: { version: "3.1", baseScore: 7.5, baseSeverity: "HIGH" },
            },
          ],
        },
        weaknesses: [
          {
            source: "nvd@nist.gov",
            type: "Primary",
            description: [{ lang: "en", value: "CWE-436" }],
          },
        ],
        configurations: [
          {
            nodes: [
              {
                operator: "OR",
                negate: false,
                cpeMatch: [
                  {
                    vulnerable: true,
                    criteria: "cpe:2.3:a:fastify:fast-uri:*:*:*:*:*:node.js:*:*",
                    versionStartIncluding: "3.0.0",
                    versionEndExcluding: "3.1.3",
                    matchCriteriaId: "5C7E71C1-3D3B-4B7E-9DF9-32AA1F6A38D1",
                  },
                  {
                    vulnerable: false,
                    criteria: "cpe:2.3:a:nodejs:node.js:-:*:*:*:*:*:*:*",
                    matchCriteriaId: "9A1B49B7-77C2-4A0E-8A2B-2D0E0A5B6F44",
                  },
                ],
              },
            ],
          },
        ],
        references: [
          {
            url: "https://github.com/fastify/fast-uri/security/advisories/GHSA-4c8g-83qw-93j6",
            source: "security-advisories@github.com",
          },
        ],
      },
    },
  ],
} as const;

// Synthetic rejected record: NVD keeps serving withdrawn CVE ids with
// vulnStatus "Rejected" instead of removing them.
const rejectedCveResponse = {
  resultsPerPage: 1,
  startIndex: 0,
  totalResults: 1,
  format: "NVD_CVE",
  version: "2.0",
  timestamp: "2026-07-22T09:15:04.113",
  vulnerabilities: [
    {
      cve: {
        id: "CVE-2026-20340",
        sourceIdentifier: "cve@mitre.org",
        published: "2026-06-27T21:15:11.870",
        lastModified: "2026-07-19T08:30:00.000",
        vulnStatus: "Rejected",
        descriptions: [{ lang: "en", value: "Rejected reason: withdrawn by its CNA." }],
        references: [],
      },
    },
  ],
} as const;

// The well-formed empty response NVD serves for a CVE id that is still
// RESERVED at MITRE (or unknown): zero results, no vulnerabilities.
const reservedCveResponse = {
  resultsPerPage: 0,
  startIndex: 0,
  totalResults: 0,
  format: "NVD_CVE",
  version: "2.0",
  timestamp: "2026-07-22T09:15:04.113",
  vulnerabilities: [],
} as const;

const testInventory = [
  {
    name: "fast-uri",
    version: "3.1.2",
    origin: "agents/openclaw/mcporter-runtime/package-lock.json",
  },
] as const;

const upstreamFastUriAdvisory = {
  ghsa_id: "GHSA-4c8g-83qw-93j6",
  cve_id: "CVE-2026-13676",
  vulnerabilities: [
    {
      package: { ecosystem: "npm", name: "fast-uri" },
      vulnerable_version_range: ">= 3.0.0, < 3.1.3",
    },
  ],
} as const;

const expectedFastUriSignal = {
  advisoryId: "GHSA-4c8g-83qw-93j6",
  cveId: "CVE-2026-13676",
  package: "fast-uri",
  vulnerableRange: ">= 3.0.0, < 3.1.3",
  matchedVersions: ["3.1.2"],
  source: "upstream-ghsa",
  confidence: "exact",
  action: "investigate",
} as const;

const signalWithoutCveId = {
  advisoryId: "GHSA-23hp-3jrh-7fpw",
  package: "tar",
  vulnerableRange: "< 7.6.0",
  matchedVersions: ["7.5.20"],
  source: "upstream-ghsa",
  confidence: "exact",
  action: "investigate",
} as const;

function parsedRecord(response: unknown): NvdRecord {
  const record = parseNvdRecord(response);
  expect(record).not.toBeNull();
  return record as NvdRecord;
}

describe("NVD 2.0 record parsing", () => {
  it("parses an analyzed NVD record including only vulnerable CPE criteria", () => {
    expect(parseNvdRecord(analyzedFastUriResponse)).toEqual({
      cveId: "CVE-2026-13676",
      vulnStatus: "Analyzed",
      published: "2026-06-29T16:15:09.230",
      lastModified: "2026-07-08T14:02:33.410",
      cpeCriteria: ["cpe:2.3:a:fastify:fast-uri:*:*:*:*:*:node.js:*:*"],
    });
  });

  it("parses a rejected NVD record with its Rejected status", () => {
    expect(parseNvdRecord(rejectedCveResponse)).toEqual({
      cveId: "CVE-2026-20340",
      vulnStatus: "Rejected",
      published: "2026-06-27T21:15:11.870",
      lastModified: "2026-07-19T08:30:00.000",
      cpeCriteria: [],
    });
  });

  it("returns null for the empty response NVD serves for reserved CVE ids", () => {
    expect(parseNvdRecord(reservedCveResponse)).toBeNull();
  });

  it.each([
    ["null", null],
    ["a number", 42],
    ["an array", []],
    ["an empty object", {}],
    ["a non-array vulnerabilities field", { vulnerabilities: 7 }],
    ["a vulnerability entry without a cve object", { vulnerabilities: [{}] }],
    ["a cve object without an id", { vulnerabilities: [{ cve: { vulnStatus: "Analyzed" } }] }],
    [
      "a cve id that is not a CVE id",
      { vulnerabilities: [{ cve: { id: "GHSA-4c8g-83qw-93j6" } }] },
    ],
    ["a numeric cve id", { vulnerabilities: [{ cve: { id: 202613676 } }] }],
  ])("returns null without throwing for malformed input: %s", (_label, input) => {
    expect(() => parseNvdRecord(input)).not.toThrow();
    expect(parseNvdRecord(input)).toBeNull();
  });

  it("skips malformed leading entries and parses the first valid vulnerability", () => {
    const response = {
      vulnerabilities: [{}, { cve: { id: "CVE-2026-13676" } }],
    };
    expect(parseNvdRecord(response)).toEqual({
      cveId: "CVE-2026-13676",
      vulnStatus: "",
      published: "",
      lastModified: "",
      cpeCriteria: [],
    });
  });

  it("deduplicates repeated CPE criteria across configurations", () => {
    const criteria = "cpe:2.3:a:fastify:fast-uri:*:*:*:*:*:node.js:*:*";
    const response = {
      vulnerabilities: [
        {
          cve: {
            id: "CVE-2026-13676",
            configurations: [
              { nodes: [{ cpeMatch: [{ vulnerable: true, criteria }] }] },
              {
                nodes: [
                  {
                    cpeMatch: [
                      { vulnerable: true, criteria },
                      { vulnerable: true, criteria: "cpe:2.3:a:isaacs:node-tar:*:*:*:*:*:*:*:*" },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    expect(parsedRecord(response).cpeCriteria).toEqual([
      criteria,
      "cpe:2.3:a:isaacs:node-tar:*:*:*:*:*:*:*:*",
    ]);
  });

  it("collects vulnerable CPE criteria from nested configuration nodes", () => {
    const vulnerableCriterion = "cpe:2.3:a:fastify:fast-uri:*:*:*:*:*:node.js:*:*";
    const contextCriterion = "cpe:2.3:a:nodejs:node.js:-:*:*:*:*:*:*:*";
    const response = {
      vulnerabilities: [
        {
          cve: {
            id: "CVE-2026-13676",
            configurations: [
              {
                nodes: [
                  {
                    nodes: [
                      {
                        cpeMatch: [
                          { vulnerable: true, criteria: vulnerableCriterion },
                          { vulnerable: false, criteria: contextCriterion },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    };

    expect(parsedRecord(response).cpeCriteria).toEqual([vulnerableCriterion]);
  });
});

describe("CVE id derivation from GHSA advisory records", () => {
  it("derives the CVE id from an advisory record's cve_id field", () => {
    expect(deriveCveId(upstreamFastUriAdvisory)).toBe("CVE-2026-13676");
  });

  it.each([
    ["null", null],
    ["a non-object", "CVE-2026-13676"],
    ["an array", [{ cve_id: "CVE-2026-13676" }]],
    ["a record without cve_id", { ghsa_id: "GHSA-4c8g-83qw-93j6" }],
    ["a null cve_id (GitHub serves null before CVE assignment)", { cve_id: null }],
    ["a numeric cve_id", { cve_id: 202613676 }],
    ["a malformed cve_id", { cve_id: "CVE-26-13676" }],
    ["a GHSA id in the cve_id field", { cve_id: "GHSA-4c8g-83qw-93j6" }],
  ])("derives no CVE id from %s", (_label, input) => {
    expect(deriveCveId(input)).toBeNull();
  });
});

describe("signal reconciliation with NVD", () => {
  it("corroborates a signal whose CVE id NVD lists as live", () => {
    const reconciliation = reconcileSignalWithNvd(
      expectedFastUriSignal,
      parsedRecord(analyzedFastUriResponse),
    );
    expect(reconciliation).toEqual({
      cveId: "CVE-2026-13676",
      nvdStatus: "Analyzed",
      nvdPublished: "2026-06-29T16:15:09.230",
      agreement: "corroborated",
      note: expect.stringMatching(/never an authoritative npm mapping/),
    });
  });

  it("reports nvd-missing when NVD has no record for the CVE id", () => {
    expect(reconcileSignalWithNvd(expectedFastUriSignal, null)).toEqual({
      cveId: "CVE-2026-13676",
      nvdStatus: null,
      nvdPublished: null,
      agreement: "nvd-missing",
      note: expect.stringMatching(/reserved/),
    });
  });

  it("reports nvd-divergent when NVD rejected the CVE id", () => {
    const signal = { ...signalWithoutCveId, cveId: "CVE-2026-20340" } as const;
    const reconciliation = reconcileSignalWithNvd(signal, parsedRecord(rejectedCveResponse));
    expect(reconciliation).toMatchObject({
      cveId: "CVE-2026-20340",
      nvdStatus: "Rejected",
      nvdPublished: "2026-06-27T21:15:11.870",
      agreement: "nvd-divergent",
    });
    expect(reconciliation?.note).toMatch(/rejected/i);
  });

  it("reports nvd-divergent when the NVD record answers a different CVE id", () => {
    const reconciliation = reconcileSignalWithNvd(
      expectedFastUriSignal,
      parsedRecord(rejectedCveResponse),
    );
    expect(reconciliation).toMatchObject({
      cveId: "CVE-2026-13676",
      agreement: "nvd-divergent",
    });
    expect(reconciliation?.note).toContain("CVE-2026-20340");
    expect(reconciliation?.note).toContain("CVE-2026-13676");
  });

  it("reconciles nothing for a signal without a CVE id", () => {
    expect(
      reconcileSignalWithNvd(signalWithoutCveId, parsedRecord(analyzedFastUriResponse)),
    ).toBeNull();
    expect(reconcileSignalWithNvd(signalWithoutCveId, null)).toBeNull();
  });

  it("never mutates the signal and never carries action or confidence", () => {
    const signal = structuredClone(expectedFastUriSignal);
    const reconciliation = reconcileSignalWithNvd(signal, parsedRecord(analyzedFastUriResponse));
    expect(signal).toEqual(expectedFastUriSignal);
    expect(reconciliation).not.toHaveProperty("action");
    expect(reconciliation).not.toHaveProperty("confidence");
  });
});

describe("cveId plumbing through advisory correlation", () => {
  it("carries the advisory's cve_id onto the emitted signal", () => {
    expect(correlateAdvisories([upstreamFastUriAdvisory], testInventory)).toEqual([
      expectedFastUriSignal,
    ]);
  });

  it("omits cveId when the advisory has none", () => {
    const advisory = {
      ghsa_id: upstreamFastUriAdvisory.ghsa_id,
      vulnerabilities: upstreamFastUriAdvisory.vulnerabilities,
    };
    const signals = correlateAdvisories([advisory], testInventory);
    expect(signals).toHaveLength(1);
    expect(signals[0]).not.toHaveProperty("cveId");
  });

  it("omits cveId when the advisory's cve_id is malformed", () => {
    const advisory = { ...upstreamFastUriAdvisory, cve_id: "not-a-cve-id" };
    const signals = correlateAdvisories([advisory], testInventory);
    expect(signals).toHaveLength(1);
    expect(signals[0]).not.toHaveProperty("cveId");
  });

  it("keeps the CVE id when a duplicate record without one merges into the signal", () => {
    const advisoryWithoutCve = {
      ghsa_id: upstreamFastUriAdvisory.ghsa_id,
      vulnerabilities: upstreamFastUriAdvisory.vulnerabilities,
    };
    expect(
      correlateAdvisories([advisoryWithoutCve, upstreamFastUriAdvisory], testInventory),
    ).toEqual([expectedFastUriSignal]);
  });
});

describe("attaching NVD reconciliations to signals", () => {
  it("annotates a correlated signal with a corroborating NVD record", () => {
    const signals = correlateAdvisories([upstreamFastUriAdvisory], testInventory);
    const annotated = attachNvdReconciliations(signals, [analyzedFastUriResponse]);
    expect(annotated).toEqual([
      {
        ...expectedFastUriSignal,
        nvd: {
          cveId: "CVE-2026-13676",
          nvdStatus: "Analyzed",
          nvdPublished: "2026-06-29T16:15:09.230",
          agreement: "corroborated",
          note: expect.stringMatching(/never an authoritative npm mapping/),
        },
      },
    ]);
  });

  it("annotates nvd-missing when no fetched record answers the signal's CVE id", () => {
    const annotated = attachNvdReconciliations([expectedFastUriSignal], []);
    expect(annotated[0]?.nvd).toMatchObject({
      cveId: "CVE-2026-13676",
      agreement: "nvd-missing",
    });
  });

  it("annotates nvd-missing when NVD served the empty reserved-id response", () => {
    const annotated = attachNvdReconciliations([expectedFastUriSignal], [reservedCveResponse]);
    expect(annotated[0]?.nvd).toMatchObject({ agreement: "nvd-missing" });
  });

  it("passes signals without a CVE id through unannotated", () => {
    const annotated = attachNvdReconciliations([signalWithoutCveId], [analyzedFastUriResponse]);
    expect(annotated).toEqual([signalWithoutCveId]);
    expect(annotated[0]).not.toHaveProperty("nvd");
  });

  it("keeps the first parseable response when duplicates answer one CVE id", () => {
    const laterRejected = JSON.parse(JSON.stringify(analyzedFastUriResponse)) as {
      vulnerabilities: { cve: { vulnStatus: string } }[];
    };
    laterRejected.vulnerabilities[0].cve.vulnStatus = "Rejected";
    const annotated = attachNvdReconciliations(
      [expectedFastUriSignal],
      [analyzedFastUriResponse, laterRejected],
    );
    expect(annotated[0]?.nvd).toMatchObject({ agreement: "corroborated", nvdStatus: "Analyzed" });
  });

  it("skips malformed NVD responses without throwing", () => {
    const malformed = [null, 42, {}, { vulnerabilities: 7 }];
    expect(() => attachNvdReconciliations([expectedFastUriSignal], malformed)).not.toThrow();
    expect(attachNvdReconciliations([expectedFastUriSignal], malformed)[0]?.nvd).toMatchObject({
      agreement: "nvd-missing",
    });
  });

  it("does not mutate the input signals", () => {
    const signals = structuredClone([expectedFastUriSignal, signalWithoutCveId]);
    attachNvdReconciliations(signals, [analyzedFastUriResponse]);
    expect(signals).toEqual([expectedFastUriSignal, signalWithoutCveId]);
  });
});

describe("advisory early-warning CLI --nvd-records", () => {
  const SCAN_CLI = path.join(
    import.meta.dirname,
    "..",
    "scripts",
    "advisory-early-warning-scan.mts",
  );
  // A synthetic package that exists only in the test's --inventory file keeps
  // the CLI run hermetic: no expectation derives from the repo's committed
  // reviewed inventory.
  const cliInventory = [{ name: "nemoclaw-fixture-package", version: "3.1.2" }];
  const cliAdvisory = {
    ghsa_id: "GHSA-4c8g-83qw-93j6",
    cve_id: "CVE-2026-13676",
    vulnerabilities: [
      {
        package: { ecosystem: "npm", name: "nemoclaw-fixture-package" },
        vulnerable_version_range: ">= 3.0.0, < 3.1.3",
      },
    ],
  };
  const expectedCliSignal = {
    advisoryId: "GHSA-4c8g-83qw-93j6",
    cveId: "CVE-2026-13676",
    package: "nemoclaw-fixture-package",
    vulnerableRange: ">= 3.0.0, < 3.1.3",
    matchedVersions: ["3.1.2"],
    source: "upstream-ghsa",
    confidence: "exact",
    action: "investigate",
  };

  function runScanCli(args: readonly string[]): string {
    return execFileSync(process.execPath, ["--experimental-strip-types", SCAN_CLI, ...args], {
      encoding: "utf-8",
    });
  }

  it("attaches reconciliations offline from --nvd-records without any network access", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-nvd-reconciliation-"));
    try {
      const inventoryPath = path.join(tempRoot, "inventory.json");
      const advisoriesPath = path.join(tempRoot, "advisories.json");
      const nvdRecordsPath = path.join(tempRoot, "nvd-records.json");
      const outputPath = path.join(tempRoot, "signals.json");
      fs.writeFileSync(inventoryPath, JSON.stringify(cliInventory));
      fs.writeFileSync(advisoriesPath, JSON.stringify([cliAdvisory]));
      fs.writeFileSync(nvdRecordsPath, JSON.stringify([analyzedFastUriResponse]));
      const stdout = runScanCli([
        "--inventory",
        inventoryPath,
        "--advisories",
        advisoriesPath,
        "--nvd-records",
        nvdRecordsPath,
        "--output",
        outputPath,
      ]);
      const signals = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as Record<string, unknown>[];
      expect(signals).toEqual([
        {
          ...expectedCliSignal,
          nvd: {
            cveId: "CVE-2026-13676",
            nvdStatus: "Analyzed",
            nvdPublished: "2026-06-29T16:15:09.230",
            agreement: "corroborated",
            note: expect.stringMatching(/never an authoritative npm mapping/),
          },
        },
      ]);
      expect(stdout).toContain("NVD: corroborated (published 2026-06-29)");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails loudly on a malformed --inventory entry instead of shrinking the inventory", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-nvd-reconciliation-"));
    try {
      const inventoryPath = path.join(tempRoot, "inventory.json");
      fs.writeFileSync(
        inventoryPath,
        JSON.stringify([
          { name: "fast-uri", version: "3.1.2" },
          { name: "", version: "1.0.0" },
        ]),
      );
      expect(() => runScanCli(["--inventory", inventoryPath, "--list-packages"])).toThrow(
        /entry 1 .* missing a non-empty string "name"/,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("emits unannotated signals when --nvd-records is not given", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-nvd-reconciliation-"));
    try {
      const inventoryPath = path.join(tempRoot, "inventory.json");
      const advisoriesPath = path.join(tempRoot, "advisories.json");
      const outputPath = path.join(tempRoot, "signals.json");
      fs.writeFileSync(inventoryPath, JSON.stringify(cliInventory));
      fs.writeFileSync(advisoriesPath, JSON.stringify([cliAdvisory]));
      const stdout = runScanCli([
        "--inventory",
        inventoryPath,
        "--advisories",
        advisoriesPath,
        "--output",
        outputPath,
      ]);
      const signals = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as Record<string, unknown>[];
      expect(signals).toEqual([expectedCliSignal]);
      expect(signals[0]).not.toHaveProperty("nvd");
      expect(stdout).not.toContain("NVD:");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
