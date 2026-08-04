// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildManagedTransportFailure } from "./managed-transport.js";
import {
  correlateManagedTransportFailure,
  formatManagedTransportCorrelation,
} from "./managed-transport-correlation.js";

const FAILED_AT_MS = Date.parse("2026-08-04T05:30:10.000Z");

function failure(target = "mcp.example.com:443") {
  return buildManagedTransportFailure({
    consumer: "mcp",
    target,
    traceId: "a".repeat(32),
    error: Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }),
  });
}

function auditLine(isoTime: string, body: string): string {
  return `${isoTime} OCSF ${body}`;
}

describe("correlateManagedTransportFailure", () => {
  it("keeps the denial for the failed endpoint inside the window (#7957)", () => {
    const log = [
      auditLine(
        "2026-08-04T05:30:09.500Z",
        "NET:OPEN [MED] DENIED curl(42) -> mcp.example.com:443 [policy:default engine:opa]",
      ),
      auditLine(
        "2026-08-04T05:30:09.700Z",
        "NET:OPEN [INFO] ALLOWED curl(42) -> other.example.com:443",
      ),
    ].join("\n");

    const correlation = correlateManagedTransportFailure(failure(), log, FAILED_AT_MS);

    expect(correlation.lines).toHaveLength(1);
    expect(correlation.lines[0].endpoint).toBe("mcp.example.com:443");
    expect(correlation.lines[0].policyDenial).toBe(true);
  });

  it("drops an audit line outside the window so a stale denial is not attributed (#7957)", () => {
    const log = auditLine(
      "2026-08-04T05:29:00.000Z",
      "NET:OPEN [MED] DENIED curl(42) -> mcp.example.com:443",
    );

    expect(correlateManagedTransportFailure(failure(), log, FAILED_AT_MS).lines).toEqual([]);
  });

  it("orders matches by audit timestamp (#7957)", () => {
    const log = [
      auditLine(
        "2026-08-04T05:30:12.000Z",
        "NET:OPEN [MED] DENIED curl(42) -> mcp.example.com:443",
      ),
      auditLine(
        "2026-08-04T05:30:08.000Z",
        "NET:OPEN [MED] DENIED curl(42) -> mcp.example.com:443",
      ),
    ].join("\n");

    const correlation = correlateManagedTransportFailure(failure(), log, FAILED_AT_MS);

    expect(correlation.lines.map((entry) => entry.timestampMs)).toEqual([
      Date.parse("2026-08-04T05:30:08.000Z"),
      Date.parse("2026-08-04T05:30:12.000Z"),
    ]);
  });

  it("states plainly that no shared identifier backs the match (#7957)", () => {
    const correlation = correlateManagedTransportFailure(failure(), "", FAILED_AT_MS);

    expect(correlation.sharedIdentifier).toBe(false);
    expect(formatManagedTransportCorrelation(correlation)).toContain(
      "correlation=endpoint_and_time",
    );
    expect(formatManagedTransportCorrelation(correlation)).toContain(
      "no sandbox audit line matched this failure window",
    );
  });

  it("renders the matched evidence under the failure trace identifier (#7957)", () => {
    const log = auditLine(
      "2026-08-04T05:30:09.500Z",
      "NET:OPEN [MED] DENIED curl(42) -> mcp.example.com:443",
    );

    const rendered = formatManagedTransportCorrelation(
      correlateManagedTransportFailure(failure(), log, FAILED_AT_MS),
    );

    expect(rendered).toContain(`trace_id=${"a".repeat(32)}`);
    expect(rendered).toContain("target=mcp.example.com:443");
    expect(rendered).toContain("matched_audit_lines=1");
    expect(rendered).toContain("DENIED curl(42) -> mcp.example.com:443");
  });
});
