// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NativePackageAvailability } from "../runtime/native-package-availability.mts";

export function nativePackageFixture(
  after: (cleanup: () => void) => unknown,
  statuses: NativePackageAvailability = { openclaw: "qualified", hermes: "qualified" },
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-package-fixture-"));
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  const record = {
    schemaVersion: 1,
    classification: "native-runtime-package-availability",
    runtimeId: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    sourceRevision: "c".repeat(40),
    agents: Object.entries(statuses).map(([agent, status]) => ({ agent, status })),
  };
  const availability = path.join(root, "runtime-package-availability.json");
  fs.writeFileSync(availability, JSON.stringify(record));
  return { root, launcher: path.join(root, "bin", "NemoClaw.exe"), availability, record };
}
