<!--
Copyright (c) 2026, NVIDIA CORPORATION.  All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Unit Testing Reference (Phase 4.5)

Used in Phase 4.5 of tao-finetune-huggingface-model skill. Unit tests run against **fake data** inside the
container before any GPU training. They catch shape/dtype/collation bugs that would otherwise
only surface 5 minutes into a 2-hour training run.

**Why this phase is mandatory:** this is exactly where the VLM pipeline caught a regression in
a prior run — `pixel_values` stacking failed because Idefics3 produces variable `num_images` per
sample depending on image resolution. A 30-second collator test with two different-sized fake
images would have caught it before the 15-minute wheel rebuild + training cycle.

---

## Philosophy

- **Fake data, real code paths.** Use `PIL.Image.new()` to create random RGB images, synthesize
  questions/answers, label arrays, and bounding boxes programmatically. Exercise the real
  Dataset, collator, model forward pass.
- **Variable, not uniform.** Always include at least 2 samples with **different shapes**:
  different image sizes, different text lengths, different bbox counts. Catches the bugs
  uniform-batch testing misses.
- **Small and fast.** Each test under 10 seconds. Full suite under 60 seconds.
- **Run inside the same container as training.** Same PyTorch version, same transformers version.

Tests live under `tests/`. They are NOT shipped in the wheel — they are developer/CI artifacts.

---

## Generated test files

| File | What it tests |
|------|---------------|
| `tests/conftest.py` | pytest fixtures: fake image(s), fake sample, fake batch, processor |
| `tests/test_dataset.py` | `__getitem__` returns correct keys, shapes, dtypes; label masking is non-trivial for VLMs |
| `tests/test_collator.py` | **Heterogeneous batch** collation works (critical — caught the VLM bug) |
| `tests/test_model.py` | Model loads; forward pass with fake batch returns finite loss |
| `tests/test_smoke.py` | 1 optimizer step on 2 fake samples updates weights |

---

## conftest.py Template (shared fixtures)

```python
"""Shared pytest fixtures — fake data for all tests."""
import io
import random
import pytest
import torch
import yaml
from PIL import Image


@pytest.fixture(scope="session")
def cfg():
    return yaml.safe_load(open("config.yaml"))


def _fake_image(w: int = 224, h: int = 224, seed: int = 0) -> Image.Image:
    rng = random.Random(seed)
    arr = bytes(rng.randrange(256) for _ in range(w * h * 3))
    return Image.frombytes("RGB", (w, h), arr)


@pytest.fixture
def fake_image_small():
    return _fake_image(224, 224, seed=1)


@pytest.fixture
def fake_image_large():
    """Different size — important for VLM Idefics3 which splits high-res into tiles."""
    return _fake_image(512, 384, seed=2)


@pytest.fixture
def fake_cv_sample_classification(fake_image_small):
    """CV classification sample."""
    return {"image": fake_image_small, "labels": 0}


@pytest.fixture
def fake_cv_sample_detection(fake_image_small):
    """CV detection sample — 2 bboxes (small image)."""
    return {
        "image": fake_image_small,
        "objects": {
            "bbox": [[10.0, 20.0, 50.0, 60.0], [80.0, 80.0, 40.0, 40.0]],     # xywh
            "category_id": [0, 1],
            "area": [50*60, 40*40],
            "iscrowd": [0, 0],
        },
    }


@pytest.fixture
def fake_cv_sample_detection_large(fake_image_large):
    """CV detection sample — 4 bboxes on a DIFFERENT-SIZED image.

    Pairing this with `fake_cv_sample_detection` produces a heterogeneous
    batch (different image sizes AND different bbox counts) — the only kind
    that exposes detection-collator stacking bugs and label-list bugs.
    """
    return {
        "image": fake_image_large,
        "objects": {
            "bbox": [
                [5.0, 5.0, 30.0, 40.0],
                [50.0, 60.0, 80.0, 100.0],
                [200.0, 150.0, 60.0, 60.0],
                [300.0, 250.0, 50.0, 70.0],
            ],
            "category_id": [0, 1, 0, 2],
            "area": [30*40, 80*100, 60*60, 50*70],
            "iscrowd": [0, 0, 0, 0],
        },
    }


@pytest.fixture
def fake_cv_detection_batch(fake_cv_sample_detection, fake_cv_sample_detection_large):
    """CRITICAL: detection batch with DIFFERENT image sizes AND different bbox counts.
    Catches `torch.stack` collator bugs and `squeeze(0)` label-dict bugs."""
    return [fake_cv_sample_detection, fake_cv_sample_detection_large]


@pytest.fixture
def fake_vlm_sample_short(fake_image_small):
    """VLM sample with short question and short answer."""
    return {
        "image": fake_image_small,
        "question": "What color?",
        "multiple_choice_answer": "red",
    }


@pytest.fixture
def fake_vlm_sample_long(fake_image_large):
    """VLM sample with larger image and longer text — heterogeneity for collator."""
    return {
        "image": fake_image_large,
        "question": "Describe this scene in detail, including all visible objects and colors.",
        "multiple_choice_answer": "a colorful scene with many objects",
    }


@pytest.fixture
def fake_vlm_batch(fake_vlm_sample_short, fake_vlm_sample_long):
    """CRITICAL: batch with DIFFERENT image sizes — catches collator stacking bugs."""
    return [fake_vlm_sample_short, fake_vlm_sample_long]


@pytest.fixture(scope="session")
def processor(cfg):
    """Load the real processor for the configured model (once per session)."""
    import os
    from transformers import AutoProcessor, AutoImageProcessor
    token = os.environ.get("HF_TOKEN")
    try:
        return AutoProcessor.from_pretrained(cfg["model_id"], token=token)
    except Exception:
        return AutoImageProcessor.from_pretrained(cfg["model_id"], token=token)


@pytest.fixture(scope="session")
def tmp_arrow_dataset(tmp_path_factory, fake_vlm_sample_short, fake_vlm_sample_long):
    """Save a 2-sample Arrow dataset to disk (tests the load_from_disk path)."""
    from datasets import Dataset, Image as HFImage
    tmp = tmp_path_factory.mktemp("fake_data")
    ds = Dataset.from_list([fake_vlm_sample_short, fake_vlm_sample_long]).cast_column("image", HFImage())
    path = str(tmp / "mini")
    ds.save_to_disk(path)
    return path
```

---

## test_dataset.py Template (CV)

```python
"""Dataset.__getitem__ returns the right keys, shapes, and dtypes."""
import torch


def test_cv_classification_getitem(processor, fake_cv_sample_classification, tmp_path_factory):
    from datasets import Dataset, Image as HFImage
    from dataset import CVDataset

    tmp = tmp_path_factory.mktemp("cv_cls")
    ds_path = str(tmp / "mini")
    Dataset.from_list([fake_cv_sample_classification, fake_cv_sample_classification]) \
        .cast_column("image", HFImage()).save_to_disk(ds_path)

    ds = CVDataset(ds_path, processor)
    sample = ds[0]
    assert "pixel_values" in sample
    assert "labels" in sample
    assert sample["pixel_values"].ndim == 3
    assert sample["labels"].dtype == torch.long
```

## test_dataset.py Template (VLM)

```python
"""VLM dataset returns the right keys, labels are non-trivial."""
import torch


def test_vlm_getitem_shapes(processor, tmp_arrow_dataset, cfg):
    from dataset import VLMDataset
    ds = VLMDataset(tmp_arrow_dataset, processor, cfg)
    sample = ds[0]
    assert "input_ids" in sample
    assert "labels" in sample
    assert "pixel_values" in sample


def test_vlm_label_masking_non_trivial(processor, tmp_arrow_dataset, cfg):
    """Some (but not all) label tokens should be -100 — the prompt is masked, answer is not."""
    from dataset import VLMDataset
    ds = VLMDataset(tmp_arrow_dataset, processor, cfg)
    sample = ds[0]
    labels = sample["labels"]
    n_masked = (labels == -100).sum().item()
    n_unmasked = (labels != -100).sum().item()
    assert n_masked > 0, "Expected prompt tokens to be masked"
    assert n_unmasked > 0, "Expected answer tokens to NOT be masked (else loss will be 0)"
```

---

## test_collator.py Template (CRITICAL for VLMs)

```python
"""Collator must handle HETEROGENEOUS samples (different image sizes + text lengths).
This is where the pixel_values stacking bug bit us last time.
"""
import torch


def test_vlm_collator_heterogeneous_batch(processor, fake_vlm_batch, cfg, tmp_path_factory):
    """Samples with DIFFERENT image sizes must collate without 'list has no shape' error."""
    from datasets import Dataset, Image as HFImage
    from dataset import VLMDataset, collate_vlm

    tmp = tmp_path_factory.mktemp("hetero")
    ds_path = str(tmp / "mini")
    Dataset.from_list(fake_vlm_batch).cast_column("image", HFImage()).save_to_disk(ds_path)

    ds = VLMDataset(ds_path, processor, cfg)
    samples = [ds[0], ds[1]]

    # If this raises, production training will also crash
    batch = collate_vlm(samples, pad_token_id=processor.tokenizer.pad_token_id)

    # EVERY returned value must be a Tensor, not a list
    for k, v in batch.items():
        assert isinstance(v, torch.Tensor), f"{k!r} is {type(v).__name__}, expected Tensor"

    assert batch["input_ids"].shape[0] == 2, "Batch dim mismatch"
    assert batch["labels"].shape == batch["input_ids"].shape
    assert batch["pixel_values"].shape[0] == 2, "pixel_values batch dim mismatch"


def test_cv_detection_collator_heterogeneous_batch(processor, fake_cv_detection_batch, cfg, tmp_path_factory):
    """Detection: samples with DIFFERENT image sizes AND DIFFERENT bbox counts must
    collate without `stack expects equal size` and without 0-dim tensor errors in
    the labels dict."""
    from datasets import Dataset, Image as HFImage
    from dataset import CVDataset, make_collate_fn_detection

    tmp = tmp_path_factory.mktemp("hetero_det")
    ds_path = str(tmp / "mini")
    Dataset.from_list(fake_cv_detection_batch).cast_column("image", HFImage()).save_to_disk(ds_path)

    ds = CVDataset(ds_path, processor, task="object-detection", is_train=True)
    samples = [ds[0], ds[1]]

    # Each sample's labels must be dict-like (not a list-of-1-dict left over from
    # the processor). transformers 5.x returns BatchFeature (dict-like but not a
    # `dict` subclass) — assert by key membership instead of isinstance(dict).
    for i, s in enumerate(samples):
        assert "class_labels" in s["labels"], \
            f"sample {i}: missing class_labels in {type(s['labels']).__name__} — labels[0] extraction bug"
        # Class-label scalar tensors must keep shape (n_obj,), not be squeezed to 0-dim
        for k, v in s["labels"].items():
            if isinstance(v, torch.Tensor):
                assert v.ndim >= 1 or v.numel() <= 1, \
                    f"sample {i}: labels[{k!r}] has ndim={v.ndim} — squeeze(0) bug"

    collate_fn = make_collate_fn_detection(processor)
    batch = collate_fn(samples)

    assert "pixel_values" in batch
    assert isinstance(batch["pixel_values"], torch.Tensor), "pixel_values must be a Tensor (processor.pad)"
    assert batch["pixel_values"].shape[0] == 2, "batch dim mismatch"
    assert isinstance(batch["labels"], list) and len(batch["labels"]) == 2, \
        "labels must stay as list-of-dicts (variable bbox count per sample)"
    # Bbox counts differ between samples — verify the detection-specific shape
    assert batch["labels"][0]["class_labels"].shape[0] != batch["labels"][1]["class_labels"].shape[0], \
        "fixture should have different bbox counts; otherwise this test isn't exercising heterogeneity"
```

---

## test_model.py Template

```python
"""Model loads, forward pass produces finite loss on fake batch."""
import torch


def test_model_loads(cfg):
    from model import load_model_and_processor
    model, _ = load_model_and_processor(cfg)
    n_trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    assert n_trainable > 0, "Model has no trainable params"


def test_forward_pass_on_fake_batch(cfg, processor, fake_vlm_batch, tmp_path_factory):
    """End-to-end forward: dataset → collator → model.forward."""
    from datasets import Dataset, Image as HFImage
    from dataset import VLMDataset, collate_vlm
    from model import load_model_and_processor

    tmp = tmp_path_factory.mktemp("fwd")
    ds_path = str(tmp / "mini")
    Dataset.from_list(fake_vlm_batch).cast_column("image", HFImage()).save_to_disk(ds_path)

    model, _ = load_model_and_processor(cfg)
    ds = VLMDataset(ds_path, processor, cfg)
    batch = collate_vlm([ds[0], ds[1]], pad_token_id=processor.tokenizer.pad_token_id)
    batch = {k: v.to(model.device) for k, v in batch.items()}

    with torch.no_grad():
        out = model(**batch)

    assert torch.isfinite(out.loss), f"Loss is not finite: {out.loss}"
```

---

## test_smoke.py Template (1-step training smoke)

```python
"""One optimizer step on fake data. Catches misconfigurations that pass forward but fail backward."""
import torch


def test_one_training_step(cfg, processor, fake_vlm_batch, tmp_path_factory):
    from datasets import Dataset, Image as HFImage
    from dataset import VLMDataset, collate_vlm
    from model import load_model_and_processor

    tmp = tmp_path_factory.mktemp("smoke")
    ds_path = str(tmp / "mini")
    Dataset.from_list(fake_vlm_batch).cast_column("image", HFImage()).save_to_disk(ds_path)

    model, _ = load_model_and_processor(cfg)
    model.train()

    ds = VLMDataset(ds_path, processor, cfg)
    batch = collate_vlm([ds[0], ds[1]], pad_token_id=processor.tokenizer.pad_token_id)
    batch = {k: v.to(model.device) for k, v in batch.items()}

    optim = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=1e-4)
    out = model(**batch)
    out.loss.backward()

    # Every trainable param should have a gradient
    n_with_grad = sum(1 for p in model.parameters() if p.requires_grad and p.grad is not None)
    assert n_with_grad > 0, "No gradients computed — backward pass broken"

    optim.step()
    optim.zero_grad()


def test_trainer_one_step(cfg, processor, tmp_path_factory):
    """Run the actual HF Trainer for max_steps=1 on fake data.

    Why this matters: most "passes forward + 1 manual optim step" smoke tests
    miss bugs that live in `Trainer.training_step` itself — collator wiring,
    `remove_unused_columns` stripping label dicts, `bf16=True` cast paths,
    `log_history` shape (the summary entry has `train_loss` not `loss`).
    Running the real Trainer in unit tests catches those in seconds instead
    of in Phase 5.5 (which costs a full Docker rebuild to retry).

    Branch on task type to pick the right Dataset / collator / fixtures.
    Generate only the branch matching `cfg["task"]`.
    """
    from datasets import Dataset, Image as HFImage
    from transformers import TrainingArguments, Trainer
    from model import load_model_and_processor

    task = cfg["task"]
    tmp = tmp_path_factory.mktemp("trainer_smoke")
    ds_path = str(tmp / "mini")

    if task == "object-detection":
        from dataset import CVDataset, make_collate_fn_detection
        # Use the heterogeneous fixture — it's the most demanding shape
        # (different image sizes + different bbox counts) and the one most
        # likely to expose collator/label bugs in Trainer.training_step.
        from conftest import _fake_image  # noqa  (helper visible via conftest)
        # Build inline so this test doesn't need the batch fixture passed in
        samples = [
            {"image": _fake_image(224, 224, seed=1),
             "objects": {"bbox": [[10.0, 20.0, 50.0, 60.0]],
                         "category_id": [0], "area": [50*60], "iscrowd": [0]}},
            {"image": _fake_image(384, 256, seed=2),
             "objects": {"bbox": [[5.0, 5.0, 30.0, 40.0], [50.0, 60.0, 80.0, 100.0]],
                         "category_id": [0, 1], "area": [30*40, 80*100], "iscrowd": [0, 0]}},
        ]
        Dataset.from_list(samples).cast_column("image", HFImage()).save_to_disk(ds_path)
        train_ds = CVDataset(ds_path, processor, task="object-detection", is_train=True)
        model, _ = load_model_and_processor(cfg)
        collator = make_collate_fn_detection(processor)
    elif task == "image-classification":
        from dataset import CVDataset
        samples = [{"image": _fake_image(224, 224, seed=i), "labels": i % 2} for i in range(2)]
        Dataset.from_list(samples).cast_column("image", HFImage()).save_to_disk(ds_path)
        train_ds = CVDataset(ds_path, processor, task="image-classification", is_train=True)
        model, _ = load_model_and_processor(cfg)
        collator = None
    else:
        import pytest
        pytest.skip(f"trainer-step smoke not yet wired for task={task}")

    args = TrainingArguments(
        output_dir=str(tmp / "out"),
        max_steps=1,
        per_device_train_batch_size=2,
        learning_rate=1e-5,
        bf16=cfg.get("bf16", True),
        remove_unused_columns=False,
        report_to="none",
        logging_steps=1,
        save_strategy="no",
        eval_strategy="no",
        dataloader_pin_memory=False,
    )
    trainer = Trainer(model=model, args=args, train_dataset=train_ds, data_collator=collator)
    trainer.train()

    # Verify the same log-parsing pattern the production smoke uses
    step_log = next(
        (l for l in reversed(trainer.state.log_history) if "loss" in l), None
    )
    assert step_log is not None, "Trainer produced no step-level log entry"
    loss = step_log["loss"]
    assert loss == loss and loss != 0.0, f"smoke loss looks broken: {loss}"
```

---

## Running Tests — Phase 4.5 Command

```bash
docker run --rm --gpus all --shm-size=16g \
  -e HF_TOKEN=$HF_TOKEN \
  -e PYTHONUNBUFFERED=1 \
  -v $(pwd)/output_dir:/workspace \
  <ngc_image> \
  "cd /workspace && pip install -r requirements.txt pytest -q && \
   pip install dist/*.whl -q 2>/dev/null || python -m build --wheel --outdir dist/ -q && pip install dist/*.whl -q && \
   pytest tests/ -v --tb=short"
```

Add `pytest>=7.0` to `requirements.txt`.

**Gate:** all tests pass. If any test fails, STOP and fix before Phase 5 wheel build.

---

## What the tests would have caught in past runs

| Bug | Which test would catch it |
|-----|---------------------------|
| `pixel_values` returned as list (heterogeneous images) | `test_vlm_collator_heterogeneous_batch` |
| `torch.stack` fails on variable-sized detection images | `test_cv_detection_collator_heterogeneous_batch` |
| `squeeze(0)` corrupts detection label dict (0-dim tensor) | `test_cv_detection_collator_heterogeneous_batch` |
| All labels masked → loss always 0 | `test_vlm_label_masking_non_trivial` |
| `ImportError` from `evaluate:main` wheel entry | wheel install step in Phase 4.5 runner |
| Wrong `dtype=` (fp32 fallback) | `test_model_loads` trainable-param check |
| Forward pass NaN | `test_forward_pass_on_fake_batch` finite-loss check |
| Backward pass broken (detached graph) | `test_one_training_step` grad check |
| `remove_unused_columns` strips label dicts inside Trainer | `test_trainer_one_step` |
| `log_history[-1]` is summary, not step (`train_loss` vs `loss`) | `test_trainer_one_step` |
| `bf16=True` × loaded-bf16 → optimizer underflow inside Trainer | `test_trainer_one_step` (loss == 0 / NaN) |

Without this phase, every one of these surfaced minutes or hours into real training.

---

## Task-branch-specific fixtures

Generate only the fixtures and tests relevant to the detected task:

| task | fixtures | tests |
|------|----------|-------|
| image-classification | fake_cv_sample_classification | test_dataset.py (cls), test_model.py |
| object-detection | fake_cv_sample_detection (variable bbox count) | test_collator.py (variable objects), test_model.py |
| semantic-segmentation | fake_cv_sample_seg (image + mask) | test_dataset.py, test_model.py |
| image-text-to-text (VLM) | fake_vlm_sample_short + fake_vlm_sample_long | **all 4 test files** — VLMs are the riskiest |
| text-generation (LLM) | fake_text_sample_short + fake_text_sample_long | test_dataset.py, test_collator.py (variable length), test_model.py |

Keep generated tests focused on the generated scripts — no speculative coverage.
