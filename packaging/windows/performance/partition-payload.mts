// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import {
  partitionDevelopmentAssets,
  planDevelopmentPartition,
} from "./partition-development-assets.mts";

const [mode, payload, output, revision, ...extra] = process.argv.slice(2);
if (
  !["plan", "partition"].includes(mode ?? "") ||
  !payload ||
  !output ||
  !/^[a-f0-9]{40}$/u.test(revision ?? "") ||
  extra.length
) {
  throw new Error(
    "Expected plan|partition, payload directory, new output path, and exact source revision.",
  );
}
// This build-time inventory reads the full tree. Run it after timed startup
// samples, never in the customer install or launch path.
const options = { expectedSourceRevision: revision };
const result =
  mode === "partition"
    ? await partitionDevelopmentAssets(payload, output, options)
    : await planDevelopmentPartition(payload, options);
if (mode === "plan") {
  await fs.writeFile(
    output,
    JSON.stringify(
      { classification: "native-windows-development-assets-plan", ...result },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
console.log(
  JSON.stringify({
    mode,
    sourceRevision: result.sourceRevision,
    filesBefore: result.filesBefore,
    bytesBefore: result.bytesBefore,
    filesEligible: result.moved.length,
    bytesEligible: result.moved.reduce((total, file) => total + file.bytes, 0),
    retainedCandidates: result.retainedCandidates.length,
    sourceInventorySha256: result.sourceInventorySha256,
    installedAcceptance: false,
  }),
);
