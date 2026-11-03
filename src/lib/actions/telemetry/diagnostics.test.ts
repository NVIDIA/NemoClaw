// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import {
  CollectionDiagnostics,
  MAX_COLLECTION_DIAGNOSTIC_BYTES,
  parseCollectionDiagnostics,
  type CollectionDiagnosticKey,
} from "./diagnostics";

it("aggregates local stage counts without accepting private categories", () => {
  const diagnostics = new CollectionDiagnostics();
  diagnostics.record("config_read.timeout");
  diagnostics.record("config_read.timeout");
  diagnostics.record("roster.config_recovered");
  diagnostics.record("private-config-name" as CollectionDiagnosticKey);
  expect(parseCollectionDiagnostics(diagnostics.serialize())).toEqual({
    "config_read.timeout": 2,
    "roster.config_recovered": 1,
  });
  expect(diagnostics.serialize()).not.toContain("private-config-name");
});

it.each([
  undefined,
  "private child output",
  "null",
  "[]",
  '{"kind":"other","counts":{"config_parse.invalid":1}}',
  '{"kind":"nemoclaw_collection_diagnostics_v1","counts":{"private-name":1}}',
  '{"kind":"nemoclaw_collection_diagnostics_v1","counts":{"config_parse.invalid":"private-value"}}',
  '{"kind":"nemoclaw_collection_diagnostics_v1","counts":{"config_parse.invalid":-1}}',
  '{"kind":"nemoclaw_collection_diagnostics_v1","counts":{"config_parse.invalid":0}}',
  '{"kind":"nemoclaw_collection_diagnostics_v1","counts":{"config_parse.invalid":1.5}}',
  '{"kind":"nemoclaw_collection_diagnostics_v1","counts":{"config_parse.invalid":9007199254740992}}',
  '{"kind":"nemoclaw_collection_diagnostics_v1","counts":{"__proto__":1}}',
  '{"kind":"nemoclaw_collection_diagnostics_v1","counts":[]}',
  '{"kind":"nemoclaw_collection_diagnostics_v1","counts":{},"stderr":"private-error"}',
  'prefix {"kind":"nemoclaw_collection_diagnostics_v1","counts":{}}',
  '{"kind":"nemoclaw_collection_diagnostics_v1","counts":{}} suffix',
])("rejects an invalid child diagnostic response: %j", (raw) => {
  expect(parseCollectionDiagnostics(raw)).toBeNull();
});

it("rejects an oversized child response before parsing", () => {
  const prefix = '{"kind":"nemoclaw_collection_diagnostics_v1","counts":{}}';
  expect(
    parseCollectionDiagnostics(prefix + " ".repeat(MAX_COLLECTION_DIAGNOSTIC_BYTES)),
  ).toBeNull();
  expect(parseCollectionDiagnostics(Buffer.alloc(MAX_COLLECTION_DIAGNOSTIC_BYTES + 1))).toBeNull();
});

it("accepts empty counts and the largest permitted integer count", () => {
  expect(parseCollectionDiagnostics(new CollectionDiagnostics().serialize())).toEqual({});
  expect(
    parseCollectionDiagnostics(
      Buffer.from(
        `{"kind":"nemoclaw_collection_diagnostics_v1","counts":{"roster_read.timeout":${Number.MAX_SAFE_INTEGER}}}`,
      ),
    ),
  ).toEqual({ "roster_read.timeout": Number.MAX_SAFE_INTEGER });
});
