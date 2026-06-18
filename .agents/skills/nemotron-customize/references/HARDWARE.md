# Hardware And Backend Routing

Use this before recommending AutoModel vs Megatron-Bridge, LoRA vs full SFT, or
remote profile sizing. Verify exact strategies from the selected step before
writing configs.

## Questions To Ask

1. GPU model and memory per GPU.
2. Number of nodes and GPUs per node.
3. Interconnect: NVLink/NVSwitch, InfiniBand, RoCE/Ethernet.
4. Backend: local, Lepton, Slurm, DGX Cloud, or another runner.
5. Storage and mount path visible to the runtime.
6. Whether the run is smoke, pilot, or production quality.

## Fast Routing

| Hardware | Prefer | Avoid / Caution |
|---|---|---|
| 1 GPU | AutoModel PEFT/SFT, small LoRA, translation/curation, eval endpoint smoke. | Megatron-Bridge full SFT/pretrain, Super3, RL. |
| 2-4 GPUs | AutoModel SFT/PEFT, Mistral/Llama-class LoRA, small eval/deploy. | Nano3 Megatron-Bridge SFT unless a step strategy explicitly supports it. |
| 8 GPUs / 1 node | Nano3 Megatron-Bridge SFT/PEFT, AutoModel larger models, small distributed smoke. | Super3 SFT/RL and large token-budget pretraining. |
| 16-32 GPUs | Super3 SFT pilot, Nano3 RL, larger SFT/PEFT. | Super3 RL at production rollout scale without careful profiling. |
| 64+ GPUs | Super3 RL, pretraining, large CPT. | Launching without a written token/reward/eval budget. |

## GPU Memory Heuristics

| GPU | Memory | Practical SFT Starting Point |
|---|---:|---|
| A100 40GB | 40GB | AutoModel LoRA or Nano3 MB with aggressive checkpointing; avoid Super3. |
| A100 80GB | 80GB | Nano3 MB SFT (`tp=4`, `cp=2` or similar); Super3 needs multi-node. |
| H100 80GB | 80GB | Nano3 MB SFT with better throughput; Super3 starts around 32 GPUs. |
| H200 141GB | 141GB | Larger micro batches and Super3 pilot shapes become easier. |
| B200 / Blackwell | 192GB class | Consider NVFP4 optimization targets; verify serving stack support. |

## Backend Fit

- **AutoModel**: HF model or checkpoint, direct JSONL, fewer GPUs, quick LoRA, HF output.
- **Megatron-Bridge**: packed Parquet, bin/idx, multi-node TP/PP/CP/EP, Megatron checkpoint output.
- **NeMo-RL**: requires validated SFT policy checkpoint, Ray/placement sizing, and reward path validation.
- **Curator / Data Designer**: may be CPU-heavy or Ray-heavy; do not allocate GPU profiles unless the selected backend needs them.
- **Evaluator**: hosted endpoint smoke can be light; checkpoint deployment eval needs model-size-appropriate GPUs.

## Interconnect Rules

- NVLink/NVSwitch: tensor parallelism within node is preferred.
- InfiniBand: pipeline/data parallelism across nodes is acceptable; enable communication overlap where supported.
- RoCE/Ethernet: avoid large tensor parallel spans across nodes; prefer smaller TP plus PP/DP.

## Guardrails

- Do not assume GPU count from model name.
- For Super3, start from a 32-GPU Megatron-Bridge plan and verify topology early.
- Start distributed validation with micro batch size 1 and a tiny config; scale only after launch and checkpoint writing are proven.
- Keep global batch size divisible by data-parallel size.
- Treat tiny configs as wiring tests, not quality evidence.
- For remote runs, env TOML selects site resources; step YAML carries step-specific runtime flags.
