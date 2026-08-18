// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingHookHandler,
  MessagingHookHandlerId,
  MessagingHookRegistration,
  MessagingManagedStartupPlaceholderAuthorization,
  MessagingManagedStartupPlaceholderAuthorizer,
} from "./types";

/** In-memory lookup table for manifest hook handler ids. */
export class MessagingHookRegistry {
  private readonly handlers = new Map<MessagingHookHandlerId, MessagingHookHandler>();
  private readonly managedStartupPlaceholderAuthorizers = new Map<
    MessagingHookHandlerId,
    Readonly<Record<string, MessagingManagedStartupPlaceholderAuthorizer>>
  >();

  constructor(registrations: readonly MessagingHookRegistration[] = []) {
    for (const registration of registrations) {
      this.register(
        registration.id,
        registration.handler,
        registration.managedStartupPlaceholderAuthorizers,
      );
    }
  }

  register(
    id: MessagingHookHandlerId,
    handler: MessagingHookHandler,
    placeholderAuthorizers: Readonly<
      Record<string, MessagingManagedStartupPlaceholderAuthorizer>
    > = {},
  ): this {
    if (this.handlers.has(id)) {
      throw new Error(`Duplicate messaging hook handler id '${id}'`);
    }

    this.handlers.set(id, handler);
    if (Object.keys(placeholderAuthorizers).length > 0) {
      this.managedStartupPlaceholderAuthorizers.set(id, placeholderAuthorizers);
    }
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

  authorizeManagedStartupPlaceholders(
    handlerId: MessagingHookHandlerId,
    outputId: string,
    value: unknown,
  ): readonly MessagingManagedStartupPlaceholderAuthorization[] {
    return this.managedStartupPlaceholderAuthorizers.get(handlerId)?.[outputId]?.(value) ?? [];
  }
}

export function createMessagingHookRegistry(
  registrations: readonly MessagingHookRegistration[] = [],
): MessagingHookRegistry {
  return new MessagingHookRegistry(registrations);
}
