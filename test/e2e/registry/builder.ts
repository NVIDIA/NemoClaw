// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AssertionGroup, TargetDefinition, TargetEnvironment } from "./types.ts";

export class TargetBuilder {
  private readonly definition: TargetDefinition;

  constructor(id: string) {
    this.definition = { id, assertionGroups: [] };
  }

  description(description: string): TargetBuilder {
    this.definition.description = description;
    return this;
  }

  manifest(manifestPath: string): TargetBuilder {
    this.definition.manifestPath = manifestPath;
    return this;
  }

  environment(environment: TargetEnvironment): TargetBuilder {
    this.definition.environment = environment;
    return this;
  }

  expectedState(expectedStateId: string): TargetBuilder {
    this.definition.expectedStateId = expectedStateId;
    return this;
  }

  suites(suiteIds: string[]): TargetBuilder {
    this.definition.suiteIds = suiteIds;
    return this;
  }

  onboardingAssertions(onboardingAssertionIds: string[]): TargetBuilder {
    this.definition.onboardingAssertionIds = onboardingAssertionIds;
    return this;
  }

  assertions(assertionGroups: AssertionGroup[]): TargetBuilder {
    this.definition.assertionGroups = assertionGroups;
    return this;
  }

  runnerRequirements(runnerRequirements: string[]): TargetBuilder {
    this.definition.runnerRequirements = runnerRequirements;
    return this;
  }

  requiredSecrets(requiredSecrets: string[]): TargetBuilder {
    this.definition.requiredSecrets = requiredSecrets;
    return this;
  }

  skippedCapabilities(skippedCapabilities: Array<Record<string, unknown>>): TargetBuilder {
    this.definition.skippedCapabilities = skippedCapabilities;
    return this;
  }

  expectedFailure(expectedFailure: import("./types.ts").ExpectedFailureContract): TargetBuilder {
    this.definition.expectedFailure = expectedFailure;
    return this;
  }

  build(): TargetDefinition {
    return {
      ...this.definition,
      assertionGroups: [...this.definition.assertionGroups],
      suiteIds: [...(this.definition.suiteIds ?? [])],
      onboardingAssertionIds: [...(this.definition.onboardingAssertionIds ?? [])],
      runnerRequirements: [...(this.definition.runnerRequirements ?? [])],
      requiredSecrets: [...(this.definition.requiredSecrets ?? [])],
      skippedCapabilities: [...(this.definition.skippedCapabilities ?? [])],
    };
  }
}

export function target(id: string): TargetBuilder {
  return new TargetBuilder(id);
}
