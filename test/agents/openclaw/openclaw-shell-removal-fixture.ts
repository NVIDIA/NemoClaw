// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

export function guardSource() {
  const source = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../../scripts/nemoclaw-start.sh"),
    "utf8",
  );
  const start = source.indexOf("# nemoclaw-configure-guard begin");
  const end = source.indexOf("# nemoclaw-configure-guard end", start);
  if (start < 0 || end < start) throw new Error("Missing emitted OpenClaw guard");
  return source.slice(start, end);
}

export function omitBetween(source: string, start: string, end: string, replacement = "") {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin);
  if (begin < 0 || finish < begin) throw new Error("Missing proposed shell removal boundary");
  return source.slice(0, begin) + replacement + source.slice(finish);
}
