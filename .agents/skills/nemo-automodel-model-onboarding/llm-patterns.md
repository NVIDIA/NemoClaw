# Dense LLM Implementation Patterns

This document describes the standard patterns for adding a dense (non-MoE) causal language model to NeMo AutoModel.

Reference implementations:
- `components/models/llama/model.py` -- canonical dense LLM (inherits PreTrainedModel)
- `components/models/qwen2/model.py` -- dense LLM with attention/QKV bias

---

## Directory Structure

A dense LLM typically needs these files:

```
components/models/<name>/
  __init__.py
  model.py
  state_dict_adapter.py
  rope_utils.py           # Only if RoPE differs from Llama
```

Most dense LLMs can reuse the standard `CombinedGateUpMLP` and `CombinedQKVAttentionMixin` without a separate `layers.py`.
However, before reusing a standard template module, make sure they are numerically equivalent.

---

## Common Imports

```python
from nemo_automodel.components.models.common import (
    BackendConfig,
    CombinedGateUpMLP,
    CombinedQKVAttentionMixin,
    initialize_rms_norm_module,
)
from nemo_automodel.components.models.common.hf_checkpointing_mixin import HFCheckpointingMixin
```

---

## Attention Class (CombinedQKVAttentionMixin)

Every custom attention class must inherit `CombinedQKVAttentionMixin` and `nn.Module`. The mixin provides `setup_qkv_projection()` and `compute_qkv()`.

```python
class NewModelAttention(CombinedQKVAttentionMixin, nn.Module):
    def __init__(self, config, layer_idx: int):
        super().__init__()
        self.config = config
        self.layer_idx = layer_idx
        self.head_dim = getattr(config, "head_dim", config.hidden_size // config.num_attention_heads)
        self.num_key_value_groups = config.num_attention_heads // config.num_key_value_heads
        self.scaling = self.head_dim ** -0.5

        # Combined QKV projection -- ALWAYS use this
        self.setup_qkv_projection(
            hidden_size=config.hidden_size,
            num_attention_heads=config.num_attention_heads,
            num_key_value_heads=config.num_key_value_heads,
            head_dim=self.head_dim,
            bias=config.attention_bias,  # False for Llama, True for Qwen2
        )

        self.o_proj = nn.Linear(
            config.num_attention_heads * self.head_dim,
            config.hidden_size,
            bias=config.attention_bias,
        )

    def forward(self, hidden_states, position_embeddings, attention_mask, ...):
        input_shape = hidden_states.shape[:-1]
        hidden_shape = (*input_shape, -1, self.head_dim)

        # compute_qkv handles the interleaved layout split
        q, k, v = self.compute_qkv(hidden_states)

        query_states = q.view(hidden_shape).transpose(1, 2)
        key_states = k.view(hidden_shape).transpose(1, 2)
        value_states = v.view(hidden_shape).transpose(1, 2)

        # Apply RoPE
        cos, sin = position_embeddings
        query_states, key_states = apply_rotary_pos_emb(query_states, key_states, cos, sin)

        # Attention (use HF's attention interface)
        attention_interface = eager_attention_forward
        if self.config._attn_implementation != "eager":
            attention_interface = ALL_ATTENTION_FUNCTIONS[self.config._attn_implementation]

        attn_output, attn_weights = attention_interface(
            self, query_states, key_states, value_states, attention_mask,
            dropout=0.0 if not self.training else self.attention_dropout,
            scaling=self.scaling,
            **kwargs,
        )

        attn_output = attn_output.reshape(*input_shape, -1).contiguous()
        attn_output = self.o_proj(attn_output)
        return attn_output, attn_weights
```

### QKV interleaved layout

The `qkv_proj` weight is stored in KV-head-grouped interleaved order:

```
[Q_group_0 | K_0 | V_0 | Q_group_1 | K_1 | V_1 | ...]
```

Where each group has `(group_size * head_dim)` Q rows, `head_dim` K rows, `head_dim` V rows. This layout ensures `ColwiseParallel` TP sharding gives each rank complete KV-head groups. The `compute_qkv()` method handles the split.

---

## MLP (CombinedGateUpMLP)

For standard SwiGLU models, use `CombinedGateUpMLP` directly:

```python
from nemo_automodel.components.models.common import CombinedGateUpMLP

class NewModelDecoderLayer(GradientCheckpointingLayer):
    def __init__(self, config, layer_idx, backend):
        super().__init__()
        self.self_attn = NewModelAttention(config=config, layer_idx=layer_idx)
        self.mlp = CombinedGateUpMLP(config=config)  # Uses config.hidden_act, config.intermediate_size
        self.input_layernorm = initialize_rms_norm_module(
            backend.rms_norm, config.hidden_size, eps=config.rms_norm_eps,
        )
        self.post_attention_layernorm = initialize_rms_norm_module(
            backend.rms_norm, config.hidden_size, eps=config.rms_norm_eps,
        )
```

`CombinedGateUpMLP` expects these config attributes:
- `hidden_size` -- model dimension
- `intermediate_size` -- MLP intermediate dimension
- `hidden_act` -- activation name (e.g., `"silu"` for SwiGLU)
- `mlp_bias` (optional, defaults to `False`) -- whether to use bias

The gate_up weight uses a row-interleaved layout: `[gate_0, up_0, gate_1, up_1, ...]`

---

## Decoder Layer

Inherit from `GradientCheckpointingLayer` for activation checkpointing support:

```python
from transformers.modeling_layers import GradientCheckpointingLayer

class NewModelDecoderLayer(GradientCheckpointingLayer):
    def __init__(self, config, layer_idx: int, backend: BackendConfig):
        super().__init__()
        self.self_attn = NewModelAttention(config=config, layer_idx=layer_idx)
        self.mlp = CombinedGateUpMLP(config=config)
        self.input_layernorm = initialize_rms_norm_module(
            backend.rms_norm, config.hidden_size, eps=config.rms_norm_eps,
        )
        self.post_attention_layernorm = initialize_rms_norm_module(
            backend.rms_norm, config.hidden_size, eps=config.rms_norm_eps,
        )

    def forward(self, hidden_states, attention_mask=None, position_ids=None,
                past_key_values=None, use_cache=False, cache_position=None,
                position_embeddings=None, **kwargs):
        # Pre-norm attention
        residual = hidden_states
        hidden_states = self.input_layernorm(hidden_states)
        hidden_states, _ = self.self_attn(
            hidden_states=hidden_states,
            attention_mask=attention_mask,
            position_embeddings=position_embeddings,
            past_key_values=past_key_values,
            cache_position=cache_position,
            **kwargs,
        )
        hidden_states = residual + hidden_states

        # Pre-norm MLP
        residual = hidden_states
        hidden_states = self.post_attention_layernorm(hidden_states)
        hidden_states = self.mlp(hidden_states)
        hidden_states = residual + hidden_states
        return hidden_states
```

---

## Model Backbone (PreTrainedModel)

The backbone holds embeddings, layers, final norm, and RoPE:

```python
class NewModelModel(NewModelPreTrainedModel):
    def __init__(self, config, backend: BackendConfig):
        super().__init__(config)
        self.embed_tokens = nn.Embedding(config.vocab_size, config.hidden_size, config.pad_token_id)
        self.layers = nn.ModuleList([
            NewModelDecoderLayer(config=config, layer_idx=i, backend=backend)
            for i in range(config.num_hidden_layers)
        ])
        self.norm = initialize_rms_norm_module(
            backend.rms_norm, config.hidden_size, eps=config.rms_norm_eps,
        )
        self.rotary_emb = NewModelRotaryEmbedding(config=config)
        self.gradient_checkpointing = False
        self.post_init()
```

---

## ForCausalLM Class (Top-Level)

This is the main class that gets registered. It must inherit `HFCheckpointingMixin` and the model's `PreTrainedModel` base:

```python
class NewModelForCausalLM(HFCheckpointingMixin, NewModelPreTrainedModel):
    # Required attributes for TP/PP
    _tied_weights_keys = {"lm_head.weight": "model.embed_tokens.weight"}
    _tp_plan = {"lm_head": "colwise_rep"}
    _pp_plan = {"lm_head": (["hidden_states"], ["logits"])}

    @classmethod
    def from_config(cls, config, backend=None, **kwargs):
        return cls(config, backend, **kwargs)

    def __init__(self, config, backend=None):
        super().__init__(config)
        self.config = config
        self.backend = backend or BackendConfig()
        self.model = NewModelModel(config=config, backend=self.backend)
        self.vocab_size = config.vocab_size
        self.lm_head = nn.Linear(config.hidden_size, config.vocab_size, bias=False)

        # State dict adapter for HF<->custom conversion
        self.state_dict_adapter = NewModelStateDictAdapter(config=self.config)
        self.post_init()

    def get_input_embeddings(self):
        return self.model.embed_tokens

    def set_input_embeddings(self, value):
        self.model.embed_tokens = value

    def get_output_embeddings(self):
        return self.lm_head

    def set_output_embeddings(self, new_embeddings):
        self.lm_head = new_embeddings

    def forward(self, input_ids=None, attention_mask=None, labels=None,
                logits_to_keep=0, **kwargs):
        outputs = self.model(input_ids=input_ids, attention_mask=attention_mask,
                             return_dict=True, **kwargs)
        hidden_states = outputs.last_hidden_state

        # logits_to_keep optimization for training
        if isinstance(logits_to_keep, int) and logits_to_keep == 0:
            logits = self.lm_head(hidden_states)
        else:
            slice_indices = slice(-logits_to_keep, None)
            logits = self.lm_head(hidden_states[:, slice_indices, :])

        loss = None
        if labels is not None:
            loss = self.loss_function(logits=logits, labels=labels,
                                     vocab_size=self.config.vocab_size, **kwargs)

        return CausalLMOutputWithPast(loss=loss, logits=logits,
                                      past_key_values=outputs.past_key_values,
                                      hidden_states=outputs.hidden_states)

# Module-level alias for registry
ModelClass = NewModelForCausalLM
```

### Required class attributes

| Attribute | Purpose | Example |
|-----------|---------|---------|
| `_tied_weights_keys` | Maps output embed to input embed for weight tying | `{"lm_head.weight": "model.embed_tokens.weight"}` |
| `_tp_plan` | Tensor parallelism sharding plan | `{"lm_head": "colwise_rep"}` |
| `_pp_plan` | Pipeline parallelism split plan | `{"lm_head": (["hidden_states"], ["logits"])}` |

### PreTrainedModel base class attributes

```python
class NewModelPreTrainedModel(PreTrainedModel):
    config_class = NewModelConfig  # or LlamaConfig, Qwen2Config, etc.
    base_model_prefix = "model"
    supports_gradient_checkpointing = True
    _no_split_modules = ["NewModelDecoderLayer"]
    _skip_keys_device_placement = ["past_key_values"]
    _supports_flash_attn = True
    _supports_sdpa = True
    _supports_flex_attn = True
```

---

## BackendConfig Integration

`BackendConfig` controls which implementations to use for attention, linear layers, norms, and RoPE. Models receive it in `__init__` and pass it down.

Key backend fields:
- `backend.attn` -- attention implementation (`"sdpa"`, `"te"`, `"flex"`)
- `backend.linear` -- linear layer implementation (`"torch"`, `"te"`)
- `backend.rms_norm` -- RMSNorm implementation (`"torch"`, `"te"`)
- `backend.rope_fusion` -- whether to use fused RoPE kernels

Usage:
```python
from nemo_automodel.components.models.common import (
    initialize_rms_norm_module,
    initialize_linear_module,
)

# Norm: selects TE or torch implementation
self.norm = initialize_rms_norm_module(backend.rms_norm, hidden_size, eps=eps)

# Linear: selects TE or torch implementation (used in MoE models, not in CombinedQKV models)
self.proj = initialize_linear_module(backend.linear, in_features, out_features, bias=False)
```

For standard dense LLMs inheriting `PreTrainedModel`, the attention backend is controlled by HF's `_attn_implementation` (set via `attn_implementation` kwarg to `from_pretrained`). The model's attention class uses `ALL_ATTENTION_FUNCTIONS` to dispatch:

```python
attention_interface = eager_attention_forward
if self.config._attn_implementation != "eager":
    attention_interface = ALL_ATTENTION_FUNCTIONS[self.config._attn_implementation]
```

---

## State Dict Adapter

For standard dense LLMs with combined QKV + combined gate_up, inherit `CombinedProjectionStateDictAdapter` directly. No overrides needed:

```python
# state_dict_adapter.py
from nemo_automodel.components.models.common.combined_projection.state_dict_adapter import (
    CombinedProjectionStateDictAdapter,
)

class NewModelStateDictAdapter(CombinedProjectionStateDictAdapter):
    def __init__(self, config):
        super().__init__(config)
```

The base class handles:
- **from_hf()**: Merges separate `q_proj`, `k_proj`, `v_proj` into interleaved `qkv_proj`; merges `gate_proj`, `up_proj` into interleaved `gate_up_proj`; ties `lm_head.weight` to `embed_tokens.weight` when missing
- **to_hf()**: Splits `qkv_proj` back to separate projections; splits `gate_up_proj` back; handles LoRA/DoRA adapter weights

### When to override

Override `from_hf()` / `to_hf()` when the model has:
- Non-standard projection names (not `q_proj`/`k_proj`/`v_proj` or `gate_proj`/`up_proj`)
- Additional weight transformations (e.g., FP8 dequantization in DeepSeek-V3)
- Custom layers that need key renaming

### DTensor bias handling

The base class provides `_gather_1d_bias()` and `_restore_1d_bias()` for safe bias manipulation under TP. 1-D bias tensors are FSDP-sharded on dim 0, and the interleaved layout may not divide evenly across shards. The helpers all-gather the bias, perform the reshape, and re-shard:

```python
q_bias, orig = self._gather_1d_bias(hf_state_dict[q_bias_key])
k_bias, _ = self._gather_1d_bias(hf_state_dict[k_bias_key])
v_bias, _ = self._gather_1d_bias(hf_state_dict[v_bias_key])
qkv_bias = self._restore_1d_bias(self._interleave_qkv(q_bias, k_bias, v_bias), orig)
```

---

## __init__.py

Keep the init file simple -- just re-export the main class:

```python
from nemo_automodel.components.models.<name>.model import NewModelForCausalLM

__all__ = ["NewModelForCausalLM"]
```

---

## Registration in registry.py

Add to the `MODEL_ARCH_MAPPING` ordered dict in `_transformers/registry.py`:

```python
(
    "NewModelForCausalLM",
    ("nemo_automodel.components.models.new_model.model", "NewModelForCausalLM"),
),
```

The tuple format is `(module_path, class_name)`. An optional third element is a set of tags:

```python
(
    "NewModelForSequenceClassification",
    ("nemo_automodel.components.models.new_model.model", "NewModelForSequenceClassification", {"retrieval"}),
),
```

---

## _tp_plan and _pp_plan Format

### _tp_plan

Maps module names (relative to the ForCausalLM class) to TP sharding strategies:

```python
_tp_plan = {"lm_head": "colwise_rep"}
```

Common values:
- `"colwise_rep"` -- shard output dim (columns), replicate input; used for `lm_head`
- `"colwise"` -- shard output dim
- `"rowwise"` -- shard input dim (rows)

The TP plan for internal layers (attention projections, MLP) is typically handled by the parallelizer based on attribute names (`qkv_proj`, `o_proj`, `gate_up_proj`, `down_proj`).

### _pp_plan

Maps module names to `(input_names, output_names)` tuples for pipeline stage boundaries:

```python
_pp_plan = {"lm_head": (["hidden_states"], ["logits"])}
```

---

## Module-Level ModelClass

Always set `ModelClass` at the bottom of `model.py`:

```python
ModelClass = NewModelForCausalLM
```

This allows the registry to lazy-import and find the class.
