# MoE (Mixture of Experts) Implementation Patterns

This document describes the patterns for adding a Mixture-of-Experts model to NeMo AutoModel.

Reference implementations:
- `components/models/deepseek_v3/model.py` -- canonical MoE LLM with MLA + grouped experts
- `components/models/mistral4/model.py` -- MoE with Mistral4-specific MLA and VLM wrapping
- `components/models/qwen3_moe/model.py` -- Qwen3 MoE variant

---

## MoE vs Dense: Key Differences

| Aspect | Dense LLM | MoE LLM |
|--------|-----------|---------|
| Base classes | `HFCheckpointingMixin, PreTrainedModel` | `HFCheckpointingMixin, nn.Module, MoEFSDPSyncMixin` |
| MLP | `CombinedGateUpMLP` for all layers | `MLP` for dense layers, `MoE` for expert layers |
| Config | HF config only | HF config + `MoEConfig` dataclass |
| State dict adapter | `CombinedProjectionStateDictAdapter` | Custom adapter with `MoESplitExpertsStateDictMixin` |
| Parallelism | FSDP + TP + PP | FSDP + TP + PP + Expert Parallelism (EP) |
| Forward signature | Standard HF-compatible | Custom (no `CausalLMOutputWithPast`, returns raw tensors) |

MoE implementations also need explicit `initialize_weights()` handling,
`initialize_linear_module()` for `lm_head`, gate bias updates via
`update_moe_gate_bias()`, and variable-length `thd` sequence packing through
`squeeze_input_for_thd`.

---

## MoEFSDPSyncMixin (Required)

Every MoE `ForCausalLM` class MUST inherit `MoEFSDPSyncMixin`. This mixin manages FSDP synchronization state during training with gradient accumulation:

```python
from nemo_automodel.components.moe.fsdp_mixin import MoEFSDPSyncMixin

class NewMoEForCausalLM(HFCheckpointingMixin, nn.Module, MoEFSDPSyncMixin):
    ...
```

The mixin provides:
- `prepare_for_grad_accumulation(pp_enabled=False)` -- defers sync/resharding at start of accumulation
- `prepare_for_final_backward(pp_enabled=False)` -- enables sync/resharding for the last backward pass

It also integrates with `patched_backward_maybe_with_nosync` for pipeline parallelism support.

Note: the mixin accesses `self.backend.enable_fsdp_optimizations` to check whether optimizations are active.

---

## MoEConfig Dataclass

MoE models need a `MoEConfig` in addition to the HF config. Build it from the HF config fields:

```python
from nemo_automodel.components.moe.config import MoEConfig

def _build_moe_config(config) -> MoEConfig:
    return MoEConfig(
        dim=config.hidden_size,
        inter_dim=config.intermediate_size,
        moe_inter_dim=config.moe_intermediate_size,
        n_routed_experts=config.n_routed_experts,       # or config.num_local_experts
        n_shared_experts=config.n_shared_experts,        # 0 if no shared experts
        n_activated_experts=config.num_experts_per_tok,
        n_expert_groups=config.n_group,                  # grouping for top-k routing
        n_limited_groups=config.topk_group,
        train_gate=True,
        gate_bias_update_factor=1e-3,
        score_func="sigmoid",          # or "softmax", "softmax_with_bias"
        route_scale=config.routed_scaling_factor,
        aux_loss_coeff=0,              # auxiliary load balancing loss coefficient
        norm_topk_prob=config.norm_topk_prob,
    )
```

All MoE models support `moe_overrides` — a dict that merges into the default `MoEConfig` construction:
```python
model = NeMoAutoModelForCausalLM.from_pretrained("model", moe_overrides={"gate_bias_update_factor": 1e-4})
```

### Model MoE defaults

| Model | `score_func` | `aux_loss_coeff` | `gate_bias_update_factor` | `e_score_correction_bias` |
|-------|-------------|-----------------|--------------------------|--------------------------|
| DeepSeek V3 | sigmoid | 0 | 1e-3 | yes |
| DeepSeek V3.2 | sigmoid | 0 | 1e-3 | yes |
| GLM4 MoE | sigmoid | 0.0 | 1e-3 | yes |
| GLM4 MoE Lite | sigmoid | 0.0 | 1e-3 | yes |
| GLM MoE DSA | sigmoid | 0.0 | 1e-3 | yes |
| Mistral4 | softmax_with_bias | 0 | 1e-3 | yes |
| MiniMax-M2 | sigmoid | 0 | 1e-3 | yes |
| NemotronV3 | sigmoid | 0.0 | 0.0 | yes |
| Qwen3 MoE | softmax | from config (0.0) | 0.0 | no |
| Qwen3.5 MoE | softmax | from config (0.001) | 0.0 | no |
| Qwen3 Next | softmax | from config | 0.0 | no |
| Qwen3 Omni MoE | softmax | from config (0.0) | 0.0 | no |
| Qwen3 VL MoE | softmax | from config (0.0) | 0.0 | no |
| Gemma4 MoE | softmax | 0.0 | 0.0 | no |
| GPT-OSS | softmax | from config | 0 | no |
| Step3.5 | config-dependent | 0.0 | 0.0 | no |

Models with `e_score_correction_bias=yes` use gate bias updates for load balancing.
Models with `e_score_correction_bias=no` may use auxiliary loss (`aux_loss_coeff`) instead.
All defaults are overridable via `moe_overrides`.

### MoEConfig fields

| Field | Type | Description |
|-------|------|-------------|
| `dim` | `int` | Model hidden dimension |
| `inter_dim` | `int` | Dense MLP intermediate dimension |
| `moe_inter_dim` | `int` | Expert MLP intermediate dimension |
| `n_routed_experts` | `int` | Total number of routed experts |
| `n_shared_experts` | `int` | Number of shared (always-active) experts |
| `n_activated_experts` | `int` | Number of experts activated per token |
| `n_expert_groups` | `int` | Number of expert groups for group-limited routing |
| `n_limited_groups` | `int` | Top-k groups selected in group-limited routing |
| `train_gate` | `bool` | Whether the gating network is trainable |
| `gate_bias_update_factor` | `float` | Step size for auxiliary gate bias updates |
| `score_func` | `str` | Routing score function: `"sigmoid"`, `"softmax"`, `"softmax_with_bias"` |
| `route_scale` | `float` | Scaling factor for routed expert outputs |
| `aux_loss_coeff` | `float` | Coefficient for auxiliary load balancing loss |
| `norm_topk_prob` | `bool` | Whether to normalize top-k routing probabilities |
| `router_bias` | `bool` | Whether router has bias (default `False`) |
| `expert_bias` | `bool` | Whether expert MLPs have bias (default `False`) |
| `expert_activation` | `str` | Expert activation: `"swiglu"`, `"quick_geglu"`, `"relu2"` |
| `moe_latent_size` | `int | None` | Latent dim for expert projections (if different from `dim`) |

---

## Block Class with Conditional MLP

MoE models typically have dense MLP for the first `first_k_dense_replace` layers and MoE for the rest:

```python
from nemo_automodel.components.moe.layers import MLP, MoE

class Block(nn.Module):
    def __init__(self, layer_idx: int, config, moe_config: MoEConfig, backend: BackendConfig):
        super().__init__()
        self.self_attn = SomeAttention(config, backend)

        # Dense layers use standard MLP, expert layers use MoE
        if layer_idx < config.first_k_dense_replace:
            self.mlp = MLP(config.hidden_size, config.intermediate_size, backend.linear)
        else:
            self.mlp = MoE(moe_config, backend)

        self.input_layernorm = initialize_rms_norm_module(
            backend.rms_norm, config.hidden_size, eps=config.rms_norm_eps,
        )
        self.post_attention_layernorm = initialize_rms_norm_module(
            backend.rms_norm, config.hidden_size, eps=config.rms_norm_eps,
        )
        self.layer_idx = layer_idx

    def forward(self, x, freqs_cis, attention_mask=None, padding_mask=None, **attn_kwargs):
        # Convert attention_mask to padding_mask for MoE routing
        if attention_mask is not None and padding_mask is None:
            padding_mask = attention_mask.bool().logical_not()

        # Pre-norm attention
        attn_out = self.self_attn(
            x=self.input_layernorm(x), freqs_cis=freqs_cis,
            attention_mask=attention_mask, **attn_kwargs,
        )
        x = x + attn_out

        # Pre-norm MLP (dense or MoE)
        mlp_out = self._mlp(x=self.post_attention_layernorm(x), padding_mask=padding_mask)
        x = x + mlp_out
        return x

    def _mlp(self, x, padding_mask):
        if isinstance(self.mlp, MLP):
            return self.mlp(x)
        else:
            assert isinstance(self.mlp, MoE)
            return self.mlp(x, padding_mask)  # MoE needs padding_mask for routing

    def init_weights(self, buffer_device):
        for norm in (self.input_layernorm, self.post_attention_layernorm):
            norm.reset_parameters()
        self.self_attn.init_weights(buffer_device)
        self.mlp.init_weights(buffer_device)
```

### Why padding_mask matters

The MoE routing layer uses `padding_mask` to exclude padding tokens from expert assignment. Without it, padding tokens consume expert capacity and waste compute.

---

## MoE Model Backbone

MoE backbones use `nn.ModuleDict` (not `nn.ModuleList`) for layers:

```python
class NewMoEModel(nn.Module):
    def __init__(self, config, backend: BackendConfig, *, moe_config=None):
        super().__init__()
        self.config = config
        self.backend = backend
        self.moe_config = moe_config or _build_moe_config(config)

        self.embed_tokens = nn.Embedding(
            config.vocab_size, config.hidden_size,
            dtype=get_dtype(config.torch_dtype, torch.bfloat16),
        )

        # ModuleDict (not ModuleList) for layer-indexed access
        self.layers = torch.nn.ModuleDict()
        for layer_id in range(config.num_hidden_layers):
            self.layers[str(layer_id)] = Block(layer_id, config, self.moe_config, backend)

        self.norm = initialize_rms_norm_module(
            backend.rms_norm, config.hidden_size, eps=config.rms_norm_eps,
        )

        # Precompute RoPE frequencies
        self.max_seq_len = config.max_position_embeddings
        rope_theta, rope_scaling, _ = get_rope_config(config)
        self.register_buffer(
            "freqs_cis",
            precompute_freqs_cis(config.qk_rope_head_dim, self.max_seq_len, rope_theta, rope_scaling),
            persistent=False,
        )
```

### Gate bias update

MoE models with trainable gate bias need a `update_moe_gate_bias()` method:

```python
def update_moe_gate_bias(self) -> None:
    with torch.no_grad():
        for _, block in self.layers.named_children():
            if isinstance(block.mlp, MoE):
                block.mlp.gate.update_bias()
```

---

## ForCausalLM for MoE

```python
class NewMoEForCausalLM(HFCheckpointingMixin, nn.Module, MoEFSDPSyncMixin):
    _keep_in_fp32_modules_strict = ["e_score_correction_bias"]  # If using sigmoid routing

    @classmethod
    def from_config(cls, config, moe_config=None, backend=None, **kwargs):
        return cls(config, moe_config, backend, **kwargs)

    def __init__(self, config, moe_config=None, backend=None, **kwargs):
        super().__init__()
        self.config = config
        self.backend = backend or BackendConfig()
        self.model = NewMoEModel(config, backend=self.backend, moe_config=moe_config)
        self.lm_head = initialize_linear_module(
            self.backend.linear, config.hidden_size, config.vocab_size, bias=False,
        )
        if self.backend.enable_hf_state_dict_adapter:
            self.state_dict_adapter = NewMoEStateDictAdapter(
                self.config, self.model.moe_config, self.backend,
                dtype=get_dtype(config.torch_dtype, torch.bfloat16),
            )

    def forward(self, input_ids, *, position_ids=None, attention_mask=None,
                padding_mask=None, **attn_kwargs):
        # Handle thd format for variable-length sequences
        if "qkv_format" in attn_kwargs and attn_kwargs["qkv_format"] == "thd":
            input_ids, position_ids, padding_mask, attn_kwargs = squeeze_input_for_thd(
                input_ids, position_ids, padding_mask, attn_kwargs,
            )
            attention_mask = None

        logits = self.model(
            input_ids, position_ids=position_ids,
            attention_mask=attention_mask, padding_mask=padding_mask,
            **attn_kwargs,
        )
        logits = self.lm_head(logits) if self.lm_head else logits

        if "qkv_format" in attn_kwargs and attn_kwargs["qkv_format"] == "thd":
            logits = logits.unsqueeze(0)
        return logits

    def update_moe_gate_bias(self) -> None:
        with torch.no_grad():
            for _, block in self.model.layers.named_children():
                if isinstance(block.mlp, MoE):
                    block.mlp.gate.update_bias()

    @torch.no_grad()
    def initialize_weights(self, buffer_device=None, dtype=torch.bfloat16):
        buffer_device = buffer_device or torch.device(f"cuda:{torch.cuda.current_device()}")
        with buffer_device:
            self.model.init_weights(buffer_device=buffer_device)
            final_out_std = self.config.hidden_size ** -0.5
            cutoff_factor = 3
            if self.lm_head is not None:
                nn.init.trunc_normal_(
                    self.lm_head.weight, mean=0.0, std=final_out_std,
                    a=-cutoff_factor * final_out_std, b=cutoff_factor * final_out_std,
                )
        self.to(dtype)

ModelClass = NewMoEForCausalLM
```

## Expert Parallelism

Expert parallelism (EP) distributes experts across devices. The MoE layer handles this internally via `moe_mesh`:

```python
from nemo_automodel.components.moe.experts import GroupedExperts, GroupedExpertsDeepEP
```

### GroupedExperts implementations

| Implementation | Import | Description |
|---------------|--------|-------------|
| `GroupedExperts` | `components/moe/experts.py` | Default: torch grouped matmul |
| `GroupedExpertsTE` | `components/moe/experts.py` | Transformer Engine grouped GEMM |
| `GroupedExpertsDeepEP` | `components/moe/experts.py` | DeepEP all-to-all dispatch |

The MoE layer selects the implementation based on `BackendConfig` and available libraries.

---

## State Dict Adapter for MoE

MoE state dict adapters must handle expert weight conversion. The base pattern uses `MoESplitExpertsStateDictMixin`:

```python
from nemo_automodel.components.checkpoint.state_dict_adapter import StateDictAdapter
from nemo_automodel.components.moe.state_dict_mixin import MoESplitExpertsStateDictMixin

class NewMoEStateDictAdapter(MoESplitExpertsStateDictMixin, StateDictAdapter):
    def __init__(self, config, moe_config, backend, dtype=torch.bfloat16):
        self.config = config
        self.moe_config = moe_config
        self.backend = backend
        self.dtype = dtype

    def from_hf(self, hf_state_dict, **kwargs):
        # 1. Rename keys from HF format to NeMo format
        # 2. Handle expert weight stacking (HF stores per-expert, NeMo stores grouped)
        # 3. Handle MLA weight conversion if applicable
        custom_state_dict = {}
        # ... key renaming and conversion logic ...
        return custom_state_dict

    def to_hf(self, state_dict, exclude_key_regex=None, **kwargs):
        # Reverse of from_hf
        hf_state_dict = {}
        # ... key renaming and conversion logic ...
        return hf_state_dict
```

### Expert weight format

HF stores expert weights as separate tensors per expert:
```
model.layers.N.mlp.experts.0.gate_proj.weight
model.layers.N.mlp.experts.0.up_proj.weight
model.layers.N.mlp.experts.0.down_proj.weight
model.layers.N.mlp.experts.1.gate_proj.weight
...
```

NeMo AutoModel stores them as stacked tensors:
```
model.layers.N.mlp.experts.gate_up_weight   # [n_experts, 2*moe_inter_dim, dim]
model.layers.N.mlp.experts.down_weight       # [n_experts, dim, moe_inter_dim]
```

The state dict adapter must stack/unstack these during conversion.

---

## LoRA for MoE

MoE models support LoRA through specialized expert-aware implementations:

```python
from nemo_automodel.components.moe.experts import GroupedExperts
# LoRA variants available:
# - GroupedExpertsLoRA (standard LoRA on expert weights)
# - GroupedExpertsDeepEPLoRA (LoRA with DeepEP dispatch)
```

LoRA on MoE typically targets the gate/up/down projections within experts, as well as attention projections (q, k, v, o).

---

## Imports Summary

```python
# Core MoE components
from nemo_automodel.components.moe.config import MoEConfig
from nemo_automodel.components.moe.fsdp_mixin import MoEFSDPSyncMixin
from nemo_automodel.components.moe.layers import MoE, MLP
from nemo_automodel.components.moe.experts import GroupedExperts, GroupedExpertsDeepEP, GroupedExpertsTE

# Common model components
from nemo_automodel.components.models.common import (
    BackendConfig,
    get_rope_config,
    initialize_linear_module,
    initialize_rms_norm_module,
)
from nemo_automodel.components.models.common.hf_checkpointing_mixin import HFCheckpointingMixin

# Utilities
from nemo_automodel.components.utils.model_utils import squeeze_input_for_thd
from nemo_automodel.shared.utils import dtype_from_str as get_dtype
```

---

## Checklist (MoE-Specific)

In addition to the standard checklist in SKILL.md:

- [ ] Built `MoEConfig` from HF config fields
- [ ] Implemented Block class with conditional MLP (dense for early layers, MoE for later)
- [ ] ForCausalLM inherits `MoEFSDPSyncMixin`
- [ ] ForCausalLM has `update_moe_gate_bias()` method
- [ ] ForCausalLM has `initialize_weights()` method
- [ ] Forward handles `thd` format via `squeeze_input_for_thd`
- [ ] Forward passes `padding_mask` to MoE layers
- [ ] State dict adapter handles expert weight stacking/unstacking
- [ ] `_keep_in_fp32_modules_strict` set for gate bias if using sigmoid routing
