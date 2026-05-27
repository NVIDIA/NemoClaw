// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

const outDir = process.argv[2] ?? ".e2e/reports";
fs.mkdirSync(outDir, { recursive: true });
const report = { generated_at: new Date(0).toISOString(), gaps: [] as unknown[] };
fs.writeFileSync(`${outDir}/gap-report.json`, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(`${outDir}/gap-report.md`, "# E2E Gap Report\n\nNo gap details generated in Phase 6 scaffold.\n");
