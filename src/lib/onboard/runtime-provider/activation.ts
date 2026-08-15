// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeProviderBundle } from "./contract";
import { createRuntimeProviderBundleRegistry } from "./registry";

export const RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION = 1 as const;

export interface RuntimeProviderActivationDeclaration {
  readonly contractVersion: typeof RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION;
  readonly providerId: string;
}

export interface RuntimeProviderActivationRegistration {
  readonly declaration: RuntimeProviderActivationDeclaration;
  readonly bundle: RuntimeProviderBundle;
}

export type RuntimeProviderActivationCatalog = Readonly<
  Record<string, Readonly<RuntimeProviderActivationRegistration>>
>;

export class RuntimeProviderActivationError extends Error {
  constructor(message: string) {
    super(`Runtime provider activation is invalid: ${message}`);
    this.name = "RuntimeProviderActivationError";
  }
}

function validateDeclaration(
  value: RuntimeProviderActivationDeclaration,
): RuntimeProviderActivationDeclaration {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.contractVersion !== RUNTIME_PROVIDER_ACTIVATION_CONTRACT_VERSION ||
    typeof value.providerId !== "string" ||
    value.providerId.trim() !== value.providerId ||
    value.providerId === ""
  ) {
    throw new RuntimeProviderActivationError("declaration identity is malformed");
  }
  return Object.freeze({ ...value });
}

export function createRuntimeProviderActivationCatalog(
  registrations: readonly RuntimeProviderActivationRegistration[],
): RuntimeProviderActivationCatalog {
  const declarations = registrations.map((registration) =>
    validateDeclaration(registration.declaration),
  );
  const bundles = createRuntimeProviderBundleRegistry(
    registrations.map((registration, index) => [
      declarations[index]!.providerId,
      registration.bundle,
    ]),
  );
  const catalog: Record<string, Readonly<RuntimeProviderActivationRegistration>> = Object.create(
    null,
  );
  for (const declaration of declarations) {
    const bundle = bundles[declaration.providerId]!;
    catalog[declaration.providerId] = Object.freeze({ declaration, bundle });
  }
  return Object.freeze(catalog);
}
