# DINO AutoML / HPO Notes

AutoML runs training — all requirements from the skill's **Training Requirements** section apply. The agent must read that section first.

For no-input local DINO AutoML smoke runs, use `DINO_AUTOML_PROFILE` from
the **Training Requirements** section. Do not inspect previous AutoML runs to infer dataset
URIs, `num_classes`, recommendation count, or interval settings.

**Recommended AutoML metric:** use explicit `metric="mAP50"` with
`direction="maximize"` and pass a custom `metric_extractor` that reads
`Validation mAP50`. Do not rely on `metric="kpi"` for generated DINO runners
unless you have verified the local resolver maps it to mAP50; loose fallback
parsing can otherwise optimize `val_loss`.

```python
import re

def extract_dino_map50(logs, metric_name):
    matches = re.findall(
        r"Validation mAP50\s*:\s*([0-9]*\.?[0-9]+(?:[eE][-+]?\d+)?)",
        logs,
    )
    return float(matches[-1]) if matches else None

runner.run(
    ...,
    automl_settings={"metric": "mAP50", "direction": "maximize", ...},
    metric_extractor=extract_dino_map50,
)
```

**Recommended hyperparameters:**

```python
automl_hyperparameters=[
    "train.optim.lr",
    "train.optim.weight_decay",
    "model.backbone",
    "model.num_queries",
    "model.dropout_ratio",
]
custom_param_ranges={
    "train.optim.lr": {"valid_min": 1e-5, "valid_max": 5e-4},
    "model.backbone": {
        "valid_options": ["resnet_50", "resnet_34"],
        "option_weights": [0.75, 0.25],
    },
    "model.num_queries": {"valid_min": 100, "valid_max": 900},
    "model.dropout_ratio": {"valid_min": 0.0, "valid_max": 0.3},
}
```

`train.optim.weight_decay` is not in the default DINO spec schema — the runner accepts it with a warning. It still works; the DINO training code picks it up from the config.

**Backbone constraint for AutoML:** The LLM brain may propose backbone names not in the supported list (see the parameter list in `spec_overrides.md`), e.g. `fan_small`, `fan_tiny`, `efficientvit_b2`. These cause training failures. Use `custom_param_ranges` to constrain categorical params when possible.
