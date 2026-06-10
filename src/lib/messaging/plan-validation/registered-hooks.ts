// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingHookRegistry } from "../hooks";
import { fail } from "./assertions";

export function assertHookHandlerRegistered(
  hooks: MessagingHookRegistry,
  handler: string,
  path: string,
): void {
  if (!hooks.get(handler)) fail(path, "hook handler is not registered");
}
