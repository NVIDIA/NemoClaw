// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingHookHandler,
  MessagingHookHandlerId,
  MessagingHookRegistration,
} from "./types";

/** In-memory lookup table for manifest hook handler ids. */
export class MessagingHookRegistry {
  private readonly handlers = new Map<MessagingHookHandlerId, MessagingHookHandler>();

  constructor(registrations: readonly MessagingHookRegistration[] = []) {
    for (const registration of registrations) {
      this.register(registration.id, registration.handler);
    }
  }

  register(id: MessagingHookHandlerId, handler: MessagingHookHandler): this {
    if (this.handlers.has(id)) {
      throw new Error(`Duplicate messaging hook handler id '${id}'`);
    }

    this.handlers.set(id, handler);
    return this;
  }

  get(id: MessagingHookHandlerId): MessagingHookHandler | undefined {
    return this.handlers.get(id);
  }

  require(id: MessagingHookHandlerId): MessagingHookHandler {
    const handler = this.get(id);
    if (!handler) {
      throw new Error(`Missing messaging hook handler '${id}'`);
    }
    return handler;
  }

  listIds(): MessagingHookHandlerId[] {
    return Array.from(this.handlers.keys());
  }
}

export function createMessagingHookRegistry(
  registrations: readonly MessagingHookRegistration[] = [],
): MessagingHookRegistry {
  return new MessagingHookRegistry(registrations);
}
