# Visual ChangeNet Datasets and Spec Overrides

Visual ChangeNet has two separate task modes with different dataset types and data source structures.

## Classify

- **Dataset type:** visual_changenet_classify
- **Formats:** default
- **Accepted dataset intents:** training, evaluation, testing, calibration
- **Monitoring metric:** val_loss

### Per-Action Dataset Requirements (Classify)

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| train | dataset.classify.train_dataset.images_dir | train_datasets | images.tar.gz | No |
| train | dataset.classify.train_dataset.csv_path | train_datasets | dataset.csv | No |
| train | dataset.classify.validation_dataset.images_dir | eval_dataset | images.tar.gz | No |
| train | dataset.classify.validation_dataset.csv_path | eval_dataset | dataset.csv | No |
| quantize | dataset.classify.train_dataset.images_dir | train_datasets | images.tar.gz | No |
| quantize | dataset.classify.train_dataset.csv_path | train_datasets | dataset.csv | No |
| quantize | dataset.classify.validation_dataset.images_dir | eval_dataset | images.tar.gz | No |
| quantize | dataset.classify.validation_dataset.csv_path | eval_dataset | dataset.csv | No |
| quantize | dataset.classify.quant_calibration_dataset.images_dir | train_datasets | images.tar.gz | No |
| evaluate | dataset.classify.validation_dataset.images_dir | eval_dataset | images.tar.gz | No |
| evaluate | dataset.classify.validation_dataset.csv_path | eval_dataset | dataset.csv | No |
| evaluate | dataset.classify.test_dataset.images_dir | eval_dataset | images.tar.gz | No |
| evaluate | dataset.classify.test_dataset.csv_path | eval_dataset | dataset.csv | No |
| inference | dataset.classify.infer_dataset.images_dir | inference_dataset | images.tar.gz | No |
| inference | dataset.classify.infer_dataset.csv_path | inference_dataset | dataset.csv | No |
| gen_trt_engine | gen_trt_engine.tensorrt.calibration.cal_image_dir | calibration_dataset | images.tar.gz | Yes |

## Segment

- **Dataset type:** visual_changenet_segment
- **Formats:** default
- **Accepted dataset intents:** training, calibration
- **Monitoring metric:** val_loss

Segment uses a paired directory structure (`A/`, `B/`, `list/`, `label/`) instead of CSV + images. The `root_dir` spec key points to the top-level directory containing all four subdirectories.

**Required files per dataset:** `A.tar.gz`, `B.tar.gz`, `list.tar.gz`, `label.tar.gz`

### Per-Action Dataset Requirements (Segment)

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| train | dataset.segment.root_dir | train_datasets | (root directory) | No |
| quantize | dataset.segment.root_dir | train_datasets | (root directory) | No |
| quantize | dataset.segment.quant_calibration_dataset.images_dir | train_datasets | (root directory) | No |
| evaluate | dataset.segment.root_dir | train_datasets | (root directory) | No |
| inference | dataset.segment.root_dir | train_datasets | (root directory) | No |
| gen_trt_engine | dataset.segment.root_dir | train_datasets | (root directory) | No |
| gen_trt_engine | gen_trt_engine.tensorrt.calibration.cal_image_dir | calibration_dataset | images.tar.gz | Yes |

## Typical Spec Overrides

Data source overrides are **mandatory for every action** — the agent MUST construct data source paths from the Per-Action Dataset Requirements tables above and include them in `spec_overrides`.

```python
S3_TRAIN = "s3://bucket/data/train"
S3_EVAL = "s3://bucket/data/eval"
```

**train (classify, mandatory data sources):**
```python
{
    "train.num_epochs": 30,
    "train.checkpoint_interval": 10,
    "train.validation_interval": 10,
    "train.num_gpus": 1,
    "train.use_distributed_sampler": False,
    "train.sync_batchnorm": False,
    "dataset.classify.train_dataset.images_dir": f"{S3_TRAIN}/images.tar.gz",
    "dataset.classify.train_dataset.csv_path": f"{S3_TRAIN}/dataset.csv",
    "dataset.classify.validation_dataset.images_dir": f"{S3_EVAL}/images.tar.gz",
    "dataset.classify.validation_dataset.csv_path": f"{S3_EVAL}/dataset.csv",
}
```

**train (segment, mandatory data sources):**
```python
{
    "train.num_epochs": 30,
    "train.checkpoint_interval": 10,
    "train.validation_interval": 10,
    "train.num_gpus": 1,
    "train.use_distributed_sampler": False,
    "train.sync_batchnorm": False,
    "dataset.segment.root_dir": f"{S3_TRAIN}",
}
```

**export (classify):**
```python
{
    "export.input_height": 896,
    "export.input_width": 224,
}
```

**export (segment):**
```python
{
    "export.input_height": 224,
    "export.input_width": 224,
}
```

**quantize (classify, mandatory data sources):**
```python
{
    "dataset.classify.train_dataset.images_dir": f"{S3_TRAIN}/images.tar.gz",
    "dataset.classify.train_dataset.csv_path": f"{S3_TRAIN}/dataset.csv",
    "dataset.classify.validation_dataset.images_dir": f"{S3_EVAL}/images.tar.gz",
    "dataset.classify.validation_dataset.csv_path": f"{S3_EVAL}/dataset.csv",
    "dataset.classify.quant_calibration_dataset.images_dir": f"{S3_TRAIN}/images.tar.gz",
}
```

**evaluate (classify, mandatory data sources):**
```python
{
    "dataset.classify.validation_dataset.images_dir": f"{S3_EVAL}/images.tar.gz",
    "dataset.classify.validation_dataset.csv_path": f"{S3_EVAL}/dataset.csv",
    "dataset.classify.test_dataset.images_dir": f"{S3_EVAL}/images.tar.gz",
    "dataset.classify.test_dataset.csv_path": f"{S3_EVAL}/dataset.csv",
}
```

**inference (classify, mandatory data sources):**
```python
{
    "dataset.classify.infer_dataset.images_dir": f"{S3_EVAL}/images.tar.gz",
    "dataset.classify.infer_dataset.csv_path": f"{S3_EVAL}/dataset.csv",
}
```

**gen_trt_engine (classify, mandatory data sources):**
```python
{
    "gen_trt_engine.tensorrt.calibration.cal_image_dir": [f"{S3_TRAIN}/images.tar.gz"],
}
```

**quantize (segment, mandatory data sources):**
```python
{
    "dataset.segment.root_dir": f"{S3_TRAIN}",
    "dataset.segment.quant_calibration_dataset.images_dir": f"{S3_TRAIN}",
}
```

**evaluate (segment, mandatory data sources):**
```python
{
    "dataset.segment.root_dir": f"{S3_TRAIN}",
}
```

**inference (segment, mandatory data sources):**
```python
{
    "dataset.segment.root_dir": f"{S3_TRAIN}",
}
```

**gen_trt_engine (segment, mandatory data sources):**
```python
{
    "dataset.segment.root_dir": f"{S3_TRAIN}",
    "gen_trt_engine.tensorrt.calibration.cal_image_dir": [f"{S3_TRAIN}/images.tar.gz"],
}
```

## Data Format

### Classify Inputs

The model needs two things from the dataset: a CSV file and an images directory. Find these in the user's dataset and set the corresponding spec fields:

| Spec field | What to set it to | Description |
|------------|-------------------|-------------|
| `dataset.classify.train_dataset.csv_path` | S3 path to the training CSV | 4-column CSV: `input_path,golden_path,label,object_name` |
| `dataset.classify.train_dataset.images_dir` | S3 path to the images directory | Contains subdirectories referenced by CSV paths |
| `dataset.classify.validation_dataset.csv_path` | S3 path to the validation CSV (optional) | Same 4-column format |
| `dataset.classify.validation_dataset.images_dir` | S3 path to the images directory (optional) | Can be same as training images_dir |

**How to find the right files:** List the dataset URI with `aws s3 ls <uri>` (or your storage CLI equivalent). Look for:
- A CSV with 4 columns (`input_path`, `golden_path`, `label`, `object_name`) — may be in a subdirectory, may have a descriptive name
- An `images/` directory (or similar) containing the image subdirectories referenced by the CSV

### Classify CSV Format

```csv
input_path,golden_path,label,object_name
data/defect,data/golden,bridge,bridge_PCB+solder_00000
```

- **input_path**: Directory path (relative to `images_dir`) containing the test/defect image.
- **golden_path**: Directory path (relative to `images_dir`) containing the golden/reference image.
- **label**: Defect class label (e.g., `bridge`, `PASS`, `NO_PASS`). For binary classification with `num_classes: 2`, the downstream loader collapses all defect labels into one class.
- **object_name**: Filename stem (no extension, no light suffix). TAO constructs the full path as: `{images_dir}/{input_path}/{object_name}_{light_suffix}{image_ext}`.

### Evaluate / Inference Inputs

| Spec field | What to set it to |
|------------|-------------------|
| `dataset.classify.test_dataset.csv_path` | S3 path to test CSV (evaluate) |
| `dataset.classify.test_dataset.images_dir` | S3 path to images (evaluate) |
| `dataset.classify.infer_dataset.csv_path` | S3 path to inference CSV (inference) |
| `dataset.classify.infer_dataset.images_dir` | S3 path to images (inference) |
| `evaluate.checkpoint` | S3 path to trained checkpoint (evaluate) |
| `inference.checkpoint` | S3 path to trained checkpoint (inference) |

### Segment Inputs

| Spec field | What to set it to |
|------------|-------------------|
| `dataset.segment.root_dir` | S3 path to root directory containing `A/`, `B/`, `list/`, `label/` subdirectories |

### Lighting Conventions

TAO builds file paths by string concatenation:

```
{images_dir}/{input_path}/{object_name}_SolderLight.jpg
```

The `input_map` config controls which lighting conditions are loaded and their channel indices. The `object_name` in the CSV must NOT include the light suffix or file extension — TAO appends those.

### Segment Data Layout

Segmentation uses a directory structure instead of CSV:

```
{root_dir}/
  A/           # Before images
  B/           # After images (same filenames as A/)
  list/        # Split files: train.txt, val.txt, test.txt
  label/       # Binary mask PNGs (0=unchanged, 255=changed)
```

The `image_ext` field in the spec (default `.jpg`) must match the actual file extensions in your dataset. If your images are `.png`, set `dataset.classify.image_ext: .png`.

## Lighting Conditions (input_map)

Visual ChangeNet supports multi-lighting-condition input via `dataset.classify.input_map`. Each key is a lighting condition name and the value is its channel index:

```yaml
input_map:
  SolderLight: 0
```

For single-lighting setups, use one entry with index 0. For multi-lighting (e.g., inspection with multiple illumination angles), add entries:

```yaml
input_map:
  SolderLight: 0
  WhiteLight: 1
  UVLight: 2
num_input: 3
```

Set `dataset.classify.num_input` to match the number of lighting conditions. The `grid_map` controls how multi-input images are tiled (default 2x2).
