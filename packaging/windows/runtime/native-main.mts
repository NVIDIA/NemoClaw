// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dispatchNativeEntry, nativeEntryModes } from "./native-dispatch.mts";

if (process.argv[2] === "--describe-runtime" && process.argv.length === 3) {
  process.stdout.write(
    JSON.stringify({ schemaVersion: 1, kind: "prebuilt-native-runtime", modes: nativeEntryModes }) +
      "\n",
  );
} else {
  dispatchNativeEntry(process.argv[2], process.argv.slice(3)).catch((error) => {
    console.error(
      error instanceof Error ? error.message : "The native application could not finish.",
    );
    process.exitCode = 1;
  });
}
