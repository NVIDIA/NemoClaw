// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  applyAddExtraProvider,
  applyRemoveExtraProvider,
  isValidExtraProviderName,
  readExtraProviders,
} from "../extra-providers";
import { withLock } from "./lock";
import { load, save } from "./persistence";

export function listExtraProviders(): string[] {
  return readExtraProviders(load());
}

export function addExtraProvider(name: string): boolean {
  if (!isValidExtraProviderName(name)) return false;
  return withLock(() => {
    const data = load();
    if (!applyAddExtraProvider(name, data)) return false;
    save(data);
    return true;
  });
}

export function removeExtraProvider(name: string): boolean {
  return withLock(() => {
    const data = load();
    if (!applyRemoveExtraProvider(name, data)) return false;
    save(data);
    return true;
  });
}
