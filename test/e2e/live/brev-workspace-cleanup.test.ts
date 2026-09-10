// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from "../fixtures/e2e-test.ts";
import { removePersistedWorkspace } from "./brev-workspace-cleanup.ts";

test(
  "removes a persisted workflow-owned Brev workspace",
  {
    meta: {
      e2ePhases: ["load the workflow ownership receipt", "remove the owned Brev workspace"],
    },
  },
  async ({ artifacts, host, progress, secrets }) => {
    await removePersistedWorkspace({ artifacts, host, progress, secrets });
  },
);
