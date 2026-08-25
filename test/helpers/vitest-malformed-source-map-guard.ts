// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import convertSourceMap from "convert-source-map";

interface SourceMapConverter {
  toObject(): unknown;
}

type SourceMapParser<Args extends unknown[]> = (
  this: unknown,
  ...args: Args
) => SourceMapConverter | null;

export interface ConvertSourceMapApi {
  fromMapFileSource(source: string, read: (filename: string) => string): SourceMapConverter | null;
  fromSource(source: string): SourceMapConverter | null;
}

const guardedParser = Symbol.for("nemoclaw.vitest-malformed-source-map-guard");
type GuardedSourceMapParser<Args extends unknown[]> = SourceMapParser<Args> & {
  [guardedParser]?: true;
};

function guardParser<Args extends unknown[]>(parser: SourceMapParser<Args>): SourceMapParser<Args> {
  const markedParser = parser as GuardedSourceMapParser<Args>;
  if (markedParser[guardedParser]) return parser;

  const guarded = function (this: unknown, ...args: Args): SourceMapConverter | null {
    try {
      return parser.apply(this, args);
    } catch {
      return null;
    }
  } as GuardedSourceMapParser<Args>;
  Object.defineProperty(guarded, guardedParser, { value: true });
  return guarded;
}

/** Keeps malformed optional source maps from replacing Vitest's real test result. */
export function installVitestMalformedSourceMapGuard(
  api: ConvertSourceMapApi = convertSourceMap as ConvertSourceMapApi,
): void {
  // Vitest 4.1 parses external dependency source maps while formatting errors.
  // A source-map-shaped string in tsx can make convert-source-map throw and
  // replace an otherwise successful run with a global parser error. This
  // mirrors the merged upstream fail-soft behavior until it reaches Vitest v4.
  api.fromSource = guardParser(api.fromSource);
  api.fromMapFileSource = guardParser(api.fromMapFileSource);
}

installVitestMalformedSourceMapGuard();
