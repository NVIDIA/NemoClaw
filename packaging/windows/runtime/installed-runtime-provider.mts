// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createInstalledRuntimeSession } from "../../../src/lib/onboard/runtime-provider/installed-session.ts";
import { createInstalledMxcRuntimeProviderBundle } from "../../../src/lib/onboard/runtime-provider/mxc-installed.ts";
import { InstalledMxcSession } from "./mxc-installed-session.mts";

/** The installed package selects its provider once, before acquiring session resources. */
export function openInstalledRuntimeSession(installation: string, runRoot: string) {
  const bundle = createInstalledMxcRuntimeProviderBundle(
    (input) => new InstalledMxcSession(input.installation, input.runRoot),
  );
  return createInstalledRuntimeSession(bundle, { installation, runRoot });
}
