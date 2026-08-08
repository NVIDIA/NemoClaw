// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Route related read-only discovery through the feature boundary so the
// onboarding entrypoint keeps one dependency for draft collection.
export { loadResourceProfiles } from "../../resources-cmd";
export {
  createLlamaCppSelectionHandler,
  createSetupNim,
  discoverInferenceIntentChoices,
  probeLlamaCppAttachment,
  resolveCurrentRuntimeProviderBundle,
  resumeManagedLlamaCppRuntime,
} from "../setup-nim-flow";
export * from "./boundary";
export * from "./controller";
export * from "./deps";
export * from "./ollama-model-selection";
export * from "./runtime";
export * from "./schema";
export * from "./seed";
export * from "./ui";
