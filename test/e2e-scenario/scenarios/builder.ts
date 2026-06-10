// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AssertionGroup, ScenarioDefinition, ScenarioEnvironment } from "./types.ts";

export class ScenarioBuilder {
  private readonly definition: ScenarioDefinition;

  constructor(id: string) {
    this.definition = { id, assertionGroups: [] };
  }

  description(description: string): ScenarioBuilder {
    this.definition.description = description;
    return this;
  }

  manifest(manifestPath: string): ScenarioBuilder {
    this.definition.manifestPath = manifestPath;
    return this;
  }

  environment(environment: ScenarioEnvironment): ScenarioBuilder {
    this.definition.environment = environment;
    return this;
  }

  expectedState(expectedStateId: string): ScenarioBuilder {
    this.definition.expectedStateId = expectedStateId;
    return this;
  }

  suites(suiteIds: string[]): ScenarioBuilder {
    this.definition.suiteIds = suiteIds;
    return this;
  }

  onboardingAssertions(onboardingAssertionIds: string[]): ScenarioBuilder {
    this.definition.onboardingAssertionIds = onboardingAssertionIds;
    return this;
  }

  assertions(assertionGroups: AssertionGroup[]): ScenarioBuilder {
    this.definition.assertionGroups = assertionGroups;
    return this;
  }

  runnerRequirements(runnerRequirements: string[]): ScenarioBuilder {
    this.definition.runnerRequirements = runnerRequirements;
    return this;
  }

  requiredSecrets(requiredSecrets: string[]): ScenarioBuilder {
    this.definition.requiredSecrets = requiredSecrets;
    return this;
  }

  skippedCapabilities(skippedCapabilities: Array<Record<string, unknown>>): ScenarioBuilder {
    this.definition.skippedCapabilities = skippedCapabilities;
    return this;
  }

  expectedFailure(expectedFailure: import("./types.ts").ExpectedFailureContract): ScenarioBuilder {
    this.definition.expectedFailure = expectedFailure;
    return this;
  }

  build(): ScenarioDefinition {
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

export function scenario(id: string): ScenarioBuilder {
  return new ScenarioBuilder(id);
}
