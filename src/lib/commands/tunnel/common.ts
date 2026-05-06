// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as registry from "../../registry";

export function serviceDeps() {
  return {
    listSandboxes: () => registry.listSandboxes(),
  };
}
