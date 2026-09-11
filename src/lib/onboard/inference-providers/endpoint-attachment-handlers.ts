// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { probeLlamaCppAttachment } from "../../inference/llama-cpp";
import { createLlamaCppSelectionHandler } from "../llama-cpp-selection";
import { createLlmmanSelectionHandler, type LlmmanSelectionDeps } from "../llmman-selection";

export { probeLlamaCppAttachment, createLlamaCppSelectionHandler, createLlmmanSelectionHandler };

type OutputDeps = Pick<LlmmanSelectionDeps, "error" | "log" | "exitProcess">;

export type EndpointAttachmentHandlerDeps = Omit<
  LlmmanSelectionDeps,
  "probeLlmmanAttachment" | keyof OutputDeps
> &
  Partial<OutputDeps>;

/** Build the llama.cpp and llmman existing-server attachment handlers from one dependency set. */
export function createEndpointAttachmentHandlers(deps: EndpointAttachmentHandlerDeps): {
  handleLlamaCppSelection: ReturnType<typeof createLlamaCppSelectionHandler>;
  handleLlmmanSelection: ReturnType<typeof createLlmmanSelectionHandler>;
} {
  const shared: LlmmanSelectionDeps = {
    ...deps,
    error: deps.error ?? ((message) => console.error(message)),
    log: deps.log ?? ((message) => console.log(message)),
    exitProcess: deps.exitProcess ?? ((code) => process.exit(code)),
  };
  return {
    handleLlamaCppSelection: createLlamaCppSelectionHandler({
      ...shared,
      probeLlamaCppAttachment,
    }),
    handleLlmmanSelection: createLlmmanSelectionHandler(shared),
  };
}
