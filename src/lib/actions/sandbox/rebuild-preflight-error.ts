// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { RD as _RD, R } from "../../cli/terminal-style";
import type { RebuildBail } from "./rebuild-credential-preflight";

export function printRebuildPreflightFailure(
  summary: string,
  detail: string,
  bailMessage: string,
  bail: RebuildBail,
  bailCode?: number,
): void {
  console.error("");
  console.error(`  ${_RD}Rebuild preflight failed:${R} ${summary}`);
  console.error(`  ${detail}`);
  console.error("  Aborting rebuild — sandbox is untouched, no data was lost.");
  if (bailCode === undefined) {
    bail(bailMessage);
  } else {
    bail(bailMessage, bailCode);
  }
}
