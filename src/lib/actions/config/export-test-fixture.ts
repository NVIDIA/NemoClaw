// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import {
  parseNemoClawConfigDocumentName,
  parseNemoClawConfigDocumentUid,
} from "../../config/model";
import type { ObservedExportSnapshot } from "../../domain/config/export-evidence";
import { sandboxId } from "../../domain/config/export-source-test-fixture";
import { runConfigExport } from "./export";
import { observeStableExportSource } from "./observe-export-source";

export async function exportSnapshots(sequence: readonly ObservedExportSnapshot[]) {
  let index = 0;
  const read = vi.fn(async () => sequence[Math.min(index++, sequence.length - 1)]!);
  const writeStdout = vi.fn(async (_contents: string) => undefined);
  const publish = vi.fn(() => ({ ok: true, outputPath: "/tmp/alpha.yaml" }) as const);
  const outcome = await runConfigExport(
    {
      sandboxName: "alpha",
      documentName: parseNemoClawConfigDocumentName("alpha"),
      target: { kind: "stdout" },
    },
    {
      observe: (name) => observeStableExportSource(name, { read }),
      createDocumentUid: () => parseNemoClawConfigDocumentUid(sandboxId),
      writeStdout,
      publish,
    },
  );
  return { outcome, read, writeStdout, publish };
}
