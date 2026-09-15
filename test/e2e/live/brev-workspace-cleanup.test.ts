// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from "../fixtures/e2e-test.ts";
import { removePersistedWorkspace } from "./brev-workspace-cleanup.ts";

test("removes a persisted workflow-owned Brev workspace", async ({
  artifacts,
  host,
  progress,
  secrets,
}) => {
  progress.phase("load the workflow ownership receipt");

  await removePersistedWorkspace({ artifacts, host, progress, secrets });
});
