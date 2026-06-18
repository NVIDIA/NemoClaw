---
name: tilegym-monkey-patch-kernels-to-transformers
description: Integrate TileGym kernels into Hugging Face `transformers` models by replacing the library's submodule(s) and certain class(es)' implementations, and patching certain class(es)' init/forward/load weight methods prior to instantiating models. Used when the user requires integrating TileGym kernels into `transformers` models.
license: CC-BY-4.0 AND Apache-2.0
compatibility: Verified on Claude Code with Opus-4.6 and onward, CodeX with GPT-5.5 and onward, and Cursor (Agent mode) with GPT-5.3-CodeX and stronger models.
metadata:
  author: "TileGym Team <TileGym@nvidia.com>"
  version: "2026.06.03"
  tags:
    - tilegym
    - transformers
    - integration
    - kernel
    - monkey-patch
---
# Integrate and create cuTile kernels into 🤗 Transformers
The main purpose of TileGym project is to provide performant kernels for LLM training and inference. We will integrate proper kernels available in TileGym project to LLM models provided by Hugging Face `transformers` library to validate end-to-end functional correctness and performance improvements. Instead of modifying `transformers` source code, we will take a non-intrusive monkey-patch approach: We will replace certain modules/classes/methods in `transformers` library that implement the Transformer model we would like to integrate, such that at model instantiation, that model's core components will be replaced by TileGym implementations. At runtime the model will actually invoke TileGym kernels under the hood. In addition, we will follow an auto-research-style agent harness loop to create and integrate new cuTile kernels to the target model to improve kernel coverage and end-to-end throughput.

## Instructions
This is for human readers: Simply prompt your favorite AI Agent with skill name and target model ID. E.g.,:
```Claude/CodeX
Hi, please /monkey-patch-kernels-to-transformers Qwen/Qwen3.5-0.8B.
```
The Agent might ask you several questions. Make clarifications and give a go confirmation.

## Workflow
1. Prepare experiment environment. Follow [environment-setup.md](./references/environment-setup.md)
2. Integrate existing TileGym kernels to the target model. Follow [kernel-integration.md](./references/kernel-integration.md)
3. Autonomously create new cuTile kernels for uncovered PyTorch code. Follow [auto-kernelize.md](./references/auto-kernelize.md)
   * Feel free to add new cuTile kernels with constraints in mind
   * Do not stop until meet auto-kernelize loop stop conditions
4. Summarize and report

## Disciplines
This is for AI Agents executing this workflow.

### Kernel inventory
Reusable transformer-local kernels must be represented with FlashInfer-Bench-style Definition and Solution metadata. Follow [kernel-inventory-schema.md](./references/kernel-inventory-schema.md) when researching compute requirements, inventorying existing kernels, proposing candidates, or creating new generated kernels.
