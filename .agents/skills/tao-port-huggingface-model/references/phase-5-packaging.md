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

Full Phase 5 walkthrough — packaging the native DL backend and deploy backend (`setup.py` console_scripts), and L0 tests for export/engine generation and trainer.

## Phase 5 — Packaging & L0 Testing

### Step 12 — Package Native DL Backend (`tao-pytorch`)

**1. The entrypoint** was created in Step 2 at `entrypoint/<model_name>.py`.

**2. Register in `tao-pytorch/setup.py`** — add to `console_scripts`:
```python
'<model_name>=nvidia_tao_pytorch.cv.<model_name>.entrypoint.<model_name>:main',
```

This allows running: `<model_name> train -e experiment_spec.yaml`

### Step 13 — Package Deployment Backend (`tao-deploy`)

**1. Create deploy entrypoint** at `tao-deploy/nvidia_tao_deploy/cv/<model_name>/entrypoint/<model_name>.py` — same pattern as tao-pytorch entrypoint, using `get_subtasks`, `command_line_parser`, `launch` from `nvidia_tao_deploy.cv.common.entrypoint.entrypoint_hydra`.

**2. Register in `tao-deploy/setup.py`** — add to `console_scripts`:
```python
'<model_name>=nvidia_tao_deploy.cv.<model_name>.entrypoint.<model_name>:main',
```

### Step 14 — L0 Tests for Export & Engine Generation

**File:** `tao-deploy/tests/<model_name>/test_<model_name>.py`

```python
import pytest
import subprocess

@pytest.mark.parametrize("model_path,spec_path", [...])
def test_gen_trt_engine(model_path, spec_path, tmp_path):
    engine_path = tmp_path / "model.engine"
    cmd = f"python {gen_trt_engine_script} -e {spec_path} gen_trt_engine.onnx_file={model_path} ..."
    result = subprocess.run(cmd, shell=True, capture_output=True)
    assert result.returncode == 0
    assert engine_path.exists()
```

Also test with `trtexec --onnx=<file> --buildOnly` to verify TRT can parse the exported ONNX graph.

### Step 15 — L0 Tests for the Trainer

**File:** `tao-pytorch/tests/cv_unit_test/<model_name>/test_trainer.py`

```python
import pytest
import pytorch_lightning as pl
from pytorch_lightning import Trainer

@pytest.mark.cv_unit
@pytest.mark.<model_name>
@pytest.mark.train
@pytest.mark.parametrize("backbone", ["<variant_1>", "<variant_2>"])
def test_trainer_fit(_test_dir, _train_spec, backbone):
    _train_spec.model.backbone.type = backbone
    dm = <ModelName>DataModule(_train_spec.dataset)
    dm.setup(stage="fit")
    model = <ModelName>PlModel(_train_spec)

    trainer = Trainer(
        devices=_train_spec.train.num_gpus,
        default_root_dir=_train_spec.results_dir,
        accelerator='gpu',
        fast_dev_run=True   # 1 train batch + 1 val batch
    )
    trainer.fit(model, dm)
    # No assertions needed — absence of exception = pass
```

Create additional test files: `test_model.py` (build_model with various backbones), `test_dataloader.py`, `test_config.py`, `test_export.py`. Use `conftest.py` for shared fixtures (minimal config, temp dirs, etc.).

---

