// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { TargetDefinition, TargetEnvironment } from "./types.ts";

export class TargetBuilder {
  private readonly definition: TargetDefinition;

  constructor(id: string) {
    this.definition = { id };
  }

  description(description: string): TargetBuilder {
    this.definition.description = description;
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

  runnerRequirements(runnerRequirements: string[]): TargetBuilder {
    this.definition.runnerRequirements = runnerRequirements;
    return this;
  }

  requiredSecrets(requiredSecrets: string[]): TargetBuilder {
    this.definition.requiredSecrets = requiredSecrets;
    return this;
  }

  expectedFailure(expectedFailure: import("./types.ts").ExpectedFailureContract): TargetBuilder {
    this.definition.expectedFailure = expectedFailure;
    return this;
  }

  build(): TargetDefinition {
    return {
      ...this.definition,
      runnerRequirements: [...(this.definition.runnerRequirements ?? [])],
      requiredSecrets: [...(this.definition.requiredSecrets ?? [])],
    };
  }
}

export function target(id: string): TargetBuilder {
  return new TargetBuilder(id);
}
