// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import convertSourceMap from "convert-source-map";

interface ConvertSourceMap {
  fromSource: (source: string) => unknown;
}

const compatibilityMarker = Symbol.for("nemoclaw.vitest-malformed-source-map-compat");

export function installMalformedSourceMapCompatibility(): void {
  const parser = convertSourceMap as ConvertSourceMap & Record<symbol, unknown>;

  if (parser[compatibilityMarker] === true) return;

  const originalFromSource = parser.fromSource;
  parser.fromSource = function ignoreMalformedInlineSourceMap(source: string): unknown {
    try {
      return originalFromSource.call(this, source);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return null;
    }
  };
  Object.defineProperty(parser, compatibilityMarker, { value: true });
}
