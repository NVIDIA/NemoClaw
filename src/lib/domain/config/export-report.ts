// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ExportOmission } from "./export-omissions";

/** Marker on the first line of an export. Bump the number only for a breaking format change. */
export const EXPORT_REPORT_MARKER = "# nemoclaw-export-report: 1";

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Drop userinfo, query and fragment from URL strings, which is where secrets ride along. */
function stripUrlSecrets(_key: string, value: unknown): unknown {
  if (typeof value !== "string" || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname === "/" && !value.endsWith("/") ? "" : url.pathname}`;
  } catch {
    return "<unparseable URL>";
  }
}

const json = (value: unknown) => JSON.stringify(value, stripUrlSecrets);

function entryLine(entry: ExportOmission): string {
  const parts = [`# ${entry.kind} ${entry.field}`];
  if (entry.value !== undefined) parts.push(`value=${json(entry.value)}`);
  if (entry.before !== undefined) parts.push(`before=${json(entry.before)}`);
  if (entry.after !== undefined) {
    parts.push(`after=${entry.after === null ? "omitted" : json(entry.after)}`);
  }
  return `${parts.join(" ")}: ${oneLine(entry.message)}`;
}

/**
 * The comment block at the top of an export. Each line is `# <kind> <field> [value=<json>]
 * [before=<json> after=<json|omitted>]: <message>`; JSON values are single-line. It holds no
 * credentials: callers pass only values that are safe to repeat.
 */
export function renderExportReportHeader(
  omissions: readonly ExportOmission[],
  gatewayEndpoint: string,
): string {
  const port = new URL(gatewayEndpoint).port;
  return (
    [
      EXPORT_REPORT_MARKER,
      "# What nemoclaw config export left out, replaced, changed, or flagged for review. These lines are comments; v1 ignores them.",
      ...omissions.map(entryLine),
      `# gateway endpoint=${json(gatewayEndpoint)} port=${port}: the export reuses the V0 gateway port. A v1 gateway started beside a running V0 gateway must use a free port.`,
    ].join("\n") + "\n"
  );
}
