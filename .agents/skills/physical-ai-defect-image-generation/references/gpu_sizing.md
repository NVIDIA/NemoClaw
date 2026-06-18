# GPU sizing for finetune and inference

The DIG workflow YAMLs ship 1-GPU defaults. When scaling `train_gpu` or
`infer_gpu` at submit time, also scale CPU and host memory together — every
rank still loads the full Cosmos-Predict2-2B + T5 tokenizer + NVDINOV2 + SAM2
+ Qwen3-VL stack into host RAM, so memory pressure grows roughly linearly
with rank count.

The agent should consult this table whenever a user asks to run multi-GPU
training or inference, and pass all three values on the `--set` line — not
just `train_gpu=N` / `infer_gpu=N`.

## Training (`train_gpu`)

Applies to `finetune.yaml`, the inline `finetune-job` group in
`texture_defect_generation_day0.yaml`,
`texture_defect_generation_day1_manual_roi.yaml`, and
`texture_defect_generation_day1_real_alignment.yaml` (when
`use_pretrained_checkpoint=false`).

| `train_gpu` | `train_cpu` | `train_memory` |
|---|---|---|
| `"1"` | `"16"` | `64Gi` |
| `"2"` | `"16"` | `96Gi` |
| `"4"` | `"32"` | `192Gi` |
| `"8"` | `"64"` | `384Gi` |

Rationale: each cosmos-predict2-2B rank uses ~33 GiB CPU RAM steady-state
during DDP sync (T5 / NVDINOV2 / SAM2 / Qwen3-VL state, dataset prefetch,
host buffers). The table allocates ~48 GiB / rank past 1-GPU to give headroom
for NCCL collective bursts and checkpoint save. See
`references/troubleshooting.md` "multi-GPU FT cgroup OOM" for the failure
mode when memory is undersized.

## Inference (`infer_gpu`)

Applies to the `anomaly-infer` task in
`texture_defect_generation_day0.yaml`,
`texture_defect_generation_day1_manual_roi.yaml`, and
`texture_defect_generation_day1_real_alignment.yaml`.

| `infer_gpu` | `infer_cpu` | `infer_memory` |
|---|---|---|
| `"1"` | `"4"` | `64Gi` |
| `"2"` | `"8"` | `96Gi` |
| `"4"` | `"16"` | `192Gi` |
| `"8"` | `"32"` | `384Gi` |

Rationale: each rank shards the workload across one GPU, but the full 2B +
tokenizer + DINOv2 + Cosmos-Predict2 stack still lands in host RAM per rank.
Hardcoding 64 GiB worked for `infer_gpu=1` but caused OOM-kills when two
ranks loaded the 2B Cosmos-Predict2 weights concurrently in the same pod —
hence the memory ramp.

## Submit-time examples

Single-GPU (defaults — nothing to pass):

```bash
osmo workflow submit assets/configs/finetune.yaml \
  --pool <pool> \
  --set name=finetune-$STAMP dig_url_root=<root> usecase=pcb
```

4-GPU finetune:

```bash
osmo workflow submit assets/configs/finetune.yaml \
  --pool <pool> \
  --set name=finetune-$STAMP dig_url_root=<root> usecase=pcb \
        train_gpu=4 train_cpu=32 train_memory=192Gi
```

8-GPU training, 1-GPU inference on a Day 1 manual-ROI run:

```bash
osmo workflow submit assets/configs/texture_defect_generation_day1_manual_roi.yaml \
  --pool <pool> \
  --set name=day1-$STAMP dig_url_root=<root> usecase=metal_surface \
        use_pretrained_checkpoint=false \
        train_gpu=8 train_cpu=64 train_memory=384Gi \
        infer_gpu=1 infer_cpu=4 infer_memory=64Gi
```

## Notes

- `train_storage` (`300Gi`) and `infer_storage` (`200Gi`) do **not** scale with
  GPU count — they're sized for the largest checkpoint + dataset shard the
  pod will ever stage, regardless of rank fan-out.
- `render_gpu` / `augment_gpu` (Day 0 only) are independent and stay at 1 —
  they are single-pod stages, not DDP.
- `train_gpu` and `infer_gpu` can be set asymmetrically on the same submit
  (e.g. 8-GPU train + 1-GPU infer) — they index different resource blocks in
  the workflow.
- If you go beyond 8 GPUs per task, extrapolate at ~8 CPU and ~48 GiB per
  additional training rank, ~4 CPU and ~48 GiB per additional inference
  rank. Validate against `references/troubleshooting.md` before running a
  long job.
