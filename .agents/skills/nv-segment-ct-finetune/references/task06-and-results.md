# NV-Segment-CT Finetune Reference

This file holds details that are useful during reproduction but too large for
`SKILL.md`. Normal agent execution should start from `../SKILL.md` and call
`../scripts/run_finetune.py`.

## Bundle Setup Notes

The wrapper repairs or downloads local bundle files after required Python
packages are installed. Manual setup is only needed when debugging a missing
asset outside normal wrapper execution:

```bash
cd skills/nv-segment-ct-finetune
hf download nvidia/NV-Segment-CT --local-dir bundle/
python -c "import urllib.request; urllib.request.urlretrieve('https://raw.githubusercontent.com/NVIDIA-Medtech/NV-Segment-CTMR/main/NV-Segment-CT/configs/label_dict.json', 'bundle/label_dict.json')"
```

Expected local files:

- `bundle/configs/train.json`
- `bundle/configs/train_continual.json`
- `bundle/configs/metadata.json`
- `bundle/label_dict.json`
- `bundle/models/model.pt`

The wrapper stages `metadata.json`, `models/model.pt`, and upstream CT config
files when the repo-local upstream cache is available.

## Task06 Sanity Recipe

The `--sanity` preset mirrors the DFW single-GPU MSD Task06 Lung Tumor tutorial:

- One GPU only; no `multi_gpu_train.json` and no `mgpu_evaluate.json`.
- Datalist: 63 labeled MSD Task06 training cases, seed-0 five-fold split, fold
  0 validation, 13 validation cases.
- Mapping: `[[1, 23]]`, because MSD label `1` is cancer and VISTA3D class `23`
  is `lung tumor`.
- Automatic class-prompt segmentation: `drop_label_prob=0.0`,
  `drop_point_prob=1.0`.
- Patch size `[128,128,128]`, resample `1.5 mm isotropic`, learning rate
  `5e-5`, epochs `5`, cache rate `1.0`.
- Generated configs: `bundle/configs/train_continual_task06_lung.json` and
  `bundle/configs/dfw_no_logging.json`.

Training config order:

```text
['configs/train.json',
 'configs/train_continual.json',
 'configs/train_continual_task06_lung.json',
 'configs/dfw_no_logging.json']
```

Original-spacing evaluation config order:

```text
['configs/train.json',
 'configs/train_continual.json',
 'configs/evaluate.json',
 'configs/train_continual_task06_lung.json',
 'configs/dfw_no_logging.json']
```

Reference scores from the DFW run:

- `formal_pretrained_val_dice`: `0.6697`
- `formal_finetuned_val_dice`: `0.6836`
- `training_start_val_dice`: `0.6763`
- `val_dice_per_epoch`: `0.6763 -> 0.6889 -> 0.6872 -> 0.6905 -> 0.6772 -> 0.6672`
- `best_epoch_index`: `3`
- Peak GPU memory: `10381 MiB` (`10.14 GiB`)

If the pretrained Dice is far below `0.669`, inspect config/checkpoint/data
drift before changing learning rate or model code.

## Label Mapping

Choose one:

- `--target-anatomy "lung tumor"`: resolves the name against
  `bundle/label_dict.json`.
- `--label-mapping '[[1, 23]]'`: maps local label value `1` to global VISTA3D
  class id `23`.
- `--auto-seg`: uses automatic class-prompt fine-tuning.

Use `--target-anatomy` when the anatomy name is unambiguous. Use
`--label-mapping` when labels have custom local values or multiple foreground
values.

## Output Field Notes

Important fields in `output.json`:

- `data_audit`: image/label pair count, skipped files, label coverage,
  spacing/orientation flags, and intensity flags.
- `formal_improvement_over_pretrained`: best-checkpoint formal score minus
  pretrained formal score.
- `improvement_over_baseline`: best training-time score minus training-start
  score.
- `regressed`: true only if the best training-time score is materially below
  training-start score.
- `sanity_reference_checks`: per-threshold recovery checks for Task06.
- `phase_peak_gpu_mb`: per-phase GPU memory samples when `nvidia-smi` is
  available.

Use `recommended_ckpt`, not the newest checkpoint. If
`finetuned_ckpt_matches_pretrained_weights` is true, the best checkpoint is the
epoch-0 pretrained state.
