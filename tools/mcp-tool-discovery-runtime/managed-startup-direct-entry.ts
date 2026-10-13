// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Startup consumers run under the sandbox filesystem policy, which permits /usr
// but not the build-time /src tree. Keep provider identity in the shipped bundle.
export { fixedNativeProvider } from "../../src/lib/inference/native-provider/fixed.ts";

export * from "../../src/lib/onboard/managed-startup/image-runtime";

import { main } from "../../src/lib/onboard/managed-startup/image-runtime";

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
