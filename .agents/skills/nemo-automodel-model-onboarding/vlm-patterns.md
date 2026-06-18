# VLM (Vision-Language Model) Implementation Patterns

This document describes the patterns for adding a VLM (ForConditionalGeneration) to NeMo AutoModel.

Reference implementations:
- `components/models/mistral4/model.py` -- `Mistral3ForConditionalGeneration` (Pixtral vision + MoE text)
- `components/models/kimivl/model.py` -- `KimiVLForConditionalGeneration` (MoonVit + DeepSeek-V3 text)
- `components/models/kimi_k25_vl/model.py` -- `KimiK25VLForConditionalGeneration`

---

## Architecture Overview

A VLM in NeMo AutoModel follows this structure:

```
ForConditionalGeneration
  +-- model (VLM wrapper, plain nn.Module)
  |     +-- vision_tower (vision encoder)
  |     +-- multi_modal_projector (maps vision features to text dim)
  |     +-- language_model (text backbone wrapper)
  |           +-- model (the actual text model, e.g., DeepseekV3Model)
  |           +-- lm_head (optional, some put it here)
  +-- lm_head (or as property proxying to language_model.lm_head)
```

The key design constraint: the top-level class and the VLM wrapper inherit from `nn.Module` (NOT `PreTrainedModel`) to avoid FSDP conflicts from PreTrainedModel's module registration hooks.

---

## Nested Config

VLMs have a nested config with `vision_config` and `text_config`:

```python
class NewVLMConfig(PretrainedConfig):
    model_type = "new_vlm"

    def __init__(
        self,
        vision_config=None,
        text_config=None,
        ignore_index=-100,
        media_placeholder_token_id=128256,  # Model-specific image token ID
        pad_token_id=0,
        tie_word_embeddings=False,  # MUST be at top level, NOT in text_config
        **kwargs,
    ):
        if vision_config is None:
            vision_config = SomeVisionConfig()
        elif isinstance(vision_config, dict):
            vision_config = SomeVisionConfig(**vision_config)
        self.vision_config = vision_config

        if text_config is None:
            text_config = SomeTextConfig()
        elif isinstance(text_config, dict):
            text_config = SomeTextConfig(**text_config)
        self.text_config = text_config

        self.ignore_index = ignore_index
        self.media_placeholder_token_id = media_placeholder_token_id

        super().__init__(
            pad_token_id=pad_token_id,
            tie_word_embeddings=tie_word_embeddings,
            **kwargs,
        )
```

### Critical: tie_word_embeddings placement

`tie_word_embeddings` MUST be set on the top-level VLM config, NOT inside `text_config`. The `CombinedProjectionStateDictAdapter` reads it from the config it receives, and for VLMs that config is the top-level one. If it is only set in `text_config`, tied weight handling breaks.

---

## Vision Tower

Two approaches for the vision encoder:

### Option A: Use HF vision model (Mistral4/Pixtral pattern)

```python
from transformers import AutoModel

vision_tower = AutoModel.from_config(config.vision_config)
```

This is the simplest approach when HF already has the vision model.

### Option B: Custom vision encoder (KimiVL/MoonVit pattern)

```python
class MoonVitPretrainedModel(nn.Module):
    def __init__(self, config):
        super().__init__()
        self.patch_embed = PatchEmbed(...)
        self.encoder = VisionEncoder(...)
        self.merge_kernel_size = config.merge_kernel_size

    def forward(self, pixel_values, grid_hws):
        hidden_states = self.patch_embed(pixel_values, grid_hws)
        hidden_states = self.encoder(hidden_states, grid_hws)
        return patch_merger(hidden_states, grid_hws, self.merge_kernel_size)
```

Custom vision encoders use standard PyTorch attention (flash_attn or SDPA), not the CombinedQKV mixin.

---

## Multi-Modal Projector

Projects vision features into the language model's hidden dimension:

```python
class NewVLMMultiModalProjector(nn.Module):
    def __init__(self, config):
        super().__init__()
        vision_config = config.vision_config
        text_config = config.text_config

        # Compute input size (depends on patch merging)
        input_size = vision_config.hidden_size * merge_factor
        self.pre_norm = nn.LayerNorm(vision_config.hidden_size)
        self.linear_1 = nn.Linear(input_size, input_size, bias=True)
        self.act = nn.GELU()
        self.linear_2 = nn.Linear(input_size, text_config.hidden_size, bias=True)

    def forward(self, image_features):
        hidden_states = self.pre_norm(image_features)
        hidden_states = self.linear_1(hidden_states.view(-1, self.hidden_size))
        hidden_states = self.act(hidden_states)
        return self.linear_2(hidden_states)
```

Or use HF's built-in projector if available:

```python
from transformers.models.mistral3.modeling_mistral3 import Mistral3MultiModalProjector
multi_modal_projector = Mistral3MultiModalProjector(config)
```

---

## VLM Model Wrapper (nn.Module, not PreTrainedModel)

The wrapper composes vision tower + projector + language model. It is a plain `nn.Module`:

```python
class NewVLMModel(nn.Module):
    def __init__(self, config, vision_tower, multi_modal_projector, language_model):
        super().__init__()
        self.config = config
        self.vision_tower = vision_tower
        self.multi_modal_projector = multi_modal_projector
        self.language_model = language_model

    # Property aliases for parallelizer access
    @property
    def layers(self):
        return self.language_model.layers

    @property
    def embed_tokens(self):
        return self.language_model.embed_tokens

    @property
    def norm(self):
        return self.language_model.norm

    def get_input_embeddings(self):
        return self.language_model.get_input_embeddings()

    def _get_image_features(self, pixel_values, image_sizes, vision_feature_layer=-1):
        """Encode images through vision tower + projector."""
        image_outputs = self.vision_tower(pixel_values, image_sizes=image_sizes, ...)
        # Select vision feature layer
        selected = image_outputs.hidden_states[vision_feature_layer]
        image_features = self.multi_modal_projector(selected)
        return image_features

    def forward(self, input_ids=None, pixel_values=None, attention_mask=None,
                position_ids=None, inputs_embeds=None, image_sizes=None, **kwargs):
        if (input_ids is None) == (inputs_embeds is None):
            raise ValueError("You must specify exactly one of input_ids or inputs_embeds")

        if inputs_embeds is None:
            inputs_embeds = self.language_model.get_input_embeddings()(input_ids)

        # Merge image features into text embeddings
        if pixel_values is not None and self.vision_tower is not None:
            image_features = self._get_image_features(pixel_values, image_sizes)
            image_features = torch.cat(image_features, dim=0).to(inputs_embeds.device, inputs_embeds.dtype)

            image_token_index = getattr(self.config, "image_token_index", 10)
            special_image_mask = (
                (input_ids == image_token_index)
                .unsqueeze(-1)
                .expand_as(inputs_embeds)
                .to(inputs_embeds.device)
            )
            inputs_embeds = inputs_embeds.masked_scatter(special_image_mask, image_features)

        hidden_states = self.language_model(
            input_ids=None,  # Pass embeddings, not ids
            inputs_embeds=inputs_embeds,
            attention_mask=attention_mask,
            position_ids=position_ids,
            **kwargs,
        )
        return hidden_states
```

---

## Language Model Backend Wrapper

The text backbone is wrapped to provide a uniform interface and avoid FSDP double-root-init:

```python
class NewVLMLanguageModelBackend(nn.Module):
    def __init__(self, config, backend, *, moe_config=None):
        super().__init__()
        # Wrap the actual text model (e.g., DeepseekV3Model, Mistral4Model)
        self.model = TextModel(config, backend, moe_config=moe_config)
        self.moe_config = self.model.moe_config  # If MoE
        self.lm_head = initialize_linear_module(
            backend.linear, config.hidden_size, config.vocab_size, bias=False,
        )

    # Property aliases so parallelizer can find layers
    @property
    def embed_tokens(self):
        return self.model.embed_tokens

    @property
    def layers(self):
        return self.model.layers

    @property
    def norm(self):
        return self.model.norm

    def get_input_embeddings(self):
        return self.embed_tokens

    def set_input_embeddings(self, value):
        self.model.embed_tokens = value

    def forward(self, input_ids=None, *, inputs_embeds=None, attention_mask=None,
                position_ids=None, **kwargs):
        h = self.model(
            input_ids=input_ids,
            inputs_embeds=inputs_embeds,
            attention_mask=attention_mask,
            position_ids=position_ids,
            **kwargs,
        )
        return BaseModelOutputWithPast(last_hidden_state=h, past_key_values=None)
```

---

## ForConditionalGeneration (Top-Level)

```python
class NewVLMForConditionalGeneration(HFCheckpointingMixin, nn.Module, MoEFSDPSyncMixin):
    # Optional: filter out configs where this model should not be used
    @classmethod
    def supports_config(cls, config) -> bool:
        text_config = getattr(config, "text_config", None)
        return text_config is not None and getattr(text_config, "model_type", None) == "expected_type"

    @classmethod
    def from_config(cls, config, moe_config=None, backend=None, **kwargs):
        return cls(config, moe_config=moe_config, backend=backend, **kwargs)

    def __init__(self, config, moe_config=None, backend=None, **kwargs):
        super().__init__()
        backend = backend or BackendConfig()
        self.config = config
        self.backend = backend
        text_config = config.text_config

        # Build components
        vision_tower = build_vision_tower(config.vision_config)
        multi_modal_projector = build_projector(config)
        language_model = NewVLMLanguageModelBackend(
            text_config, backend=backend, moe_config=moe_config,
        )

        self.model = NewVLMModel(
            config=config,
            vision_tower=vision_tower,
            multi_modal_projector=multi_modal_projector,
            language_model=language_model,
        )

        self.vocab_size = text_config.vocab_size
        self.image_token_index = getattr(config, "image_token_index", 10)

        if backend.enable_hf_state_dict_adapter:
            self.state_dict_adapter = NewVLMStateDictAdapter(config, ...)

    def get_input_embeddings(self):
        return self.model.language_model.embed_tokens

    def set_input_embeddings(self, value):
        self.model.language_model.set_input_embeddings(value)

    @property
    def lm_head(self):
        return self.model.language_model.lm_head

    def get_output_embeddings(self):
        return self.model.language_model.lm_head

    def set_output_embeddings(self, new_embeddings):
        self.model.language_model.lm_head = new_embeddings

    def forward(self, input_ids=None, *, position_ids=None, attention_mask=None,
                pixel_values=None, image_sizes=None, inputs_embeds=None, **kwargs):
        # PP VLM support: retrieve pixel_values from stored chunks
        if (
            pixel_values is None
            and hasattr(self, "_vlm_pixel_values_chunks")
            and self._vlm_pixel_values_chunks is not None
        ):
            has_media_tokens = (
                input_ids is not None
                and self.image_token_index is not None
                and (input_ids == self.image_token_index).any()
            )
            if has_media_tokens:
                chunk_idx = getattr(self, "_vlm_chunk_idx", 0)
                if chunk_idx < len(self._vlm_pixel_values_chunks):
                    pixel_values = self._vlm_pixel_values_chunks[chunk_idx]
                    # Also handle image_grid_hws if needed
                    self._vlm_chunk_idx = chunk_idx + 1

        outputs = self.model(
            input_ids=input_ids,
            pixel_values=pixel_values,
            attention_mask=attention_mask,
            position_ids=position_ids,
            inputs_embeds=inputs_embeds,
            image_sizes=image_sizes,
            **kwargs,
        )

        hidden_states = outputs.last_hidden_state if hasattr(outputs, "last_hidden_state") else outputs
        logits = self.lm_head(hidden_states) if self.lm_head is not None else hidden_states
        return logits

ModelClass = NewVLMForConditionalGeneration
```

---

## Return Types

VLMs may use the HF `LlavaCausalLMOutputWithPast` return type for HF-compatible output:

```python
from transformers.models.llava.modeling_llava import LlavaCausalLMOutputWithPast
```

However, most NeMo AutoModel VLM implementations return raw logits tensors from `forward()` for simplicity and compatibility with the training loop.

---

## State Dict Adapter for VLMs

VLM state dict adapters must handle both vision and language weights. Two patterns:

### Pattern A: Separate adapters (Mistral4)

```python
class NewVLMMultimodalStateDictAdapter(StateDictAdapter):
    def __init__(self, config, moe_config, backend, dtype):
        self.text_adapter = NewVLMTextStateDictAdapter(config.text_config, moe_config, backend, dtype)

    def from_hf(self, hf_state_dict, **kwargs):
        # Text keys: prefix "model.language_model.model." or "model.text_model."
        # Vision keys: prefix "model.vision_tower." or "vision_model."
        # Projector keys: prefix "model.multi_modal_projector."
        return self.text_adapter.from_hf(hf_state_dict, **kwargs)

    def to_hf(self, state_dict, **kwargs):
        return self.text_adapter.to_hf(state_dict, **kwargs)
```

### Pattern B: Delegate to language adapter (KimiVL)

If the language model is an existing architecture (e.g., DeepSeek-V3), reuse its adapter:

```python
# KimiVL reuses DeepSeekV3StateDictAdapter directly
self.state_dict_adapter = DeepSeekV3StateDictAdapter(
    self.config, self.model.language_model.moe_config, self.backend, dtype=...
)
```

---

## pixel_values / Image Inputs Handling

VLMs receive image data through `pixel_values` (and optionally `image_sizes` / `image_grid_hws`). The flow is:

1. Processor/collator packs images into `pixel_values` tensor
2. Vision tower encodes `pixel_values` into `image_features`
3. Projector maps `image_features` to text hidden dim
4. Image features are merged into text embeddings at special token positions via `masked_scatter`

```python
# Standard image-text merge pattern:
image_token_index = getattr(self.config, "image_token_index", 10)
special_image_mask = (
    (input_ids == image_token_index)
    .unsqueeze(-1)
    .expand_as(inputs_embeds)
    .to(inputs_embeds.device)
)
inputs_embeds = inputs_embeds.masked_scatter(special_image_mask, image_features)
```

---

## Pipeline Parallelism Support for VLMs

VLMs need special handling for PP because vision inputs are only relevant at the first stage. The pattern uses `_vlm_pixel_values_chunks` and `_vlm_chunk_idx` to pass pixel values across micro-batches:

```python
# In forward():
if (
    pixel_values is None
    and hasattr(self, "_vlm_pixel_values_chunks")
    and self._vlm_pixel_values_chunks is not None
):
    has_media_tokens = (
        input_ids is not None
        and self.image_token_index is not None
        and (input_ids == self.image_token_index).any()
    )
    if has_media_tokens:
        chunk_idx = getattr(self, "_vlm_chunk_idx", 0)
        if chunk_idx < len(self._vlm_pixel_values_chunks):
            pixel_values = self._vlm_pixel_values_chunks[chunk_idx]
            self._vlm_chunk_idx = chunk_idx + 1
```

---

## Registration

VLMs are registered in `MODEL_ARCH_MAPPING` just like LLMs:

```python
(
    "NewVLMForConditionalGeneration",
    ("nemo_automodel.components.models.new_vlm.model", "NewVLMForConditionalGeneration"),
),
```

If the model has a custom config class (not natively supported by HF's `AutoConfig`), also register in `_CUSTOM_CONFIG_REGISTRATIONS`:

```python
_CUSTOM_CONFIG_REGISTRATIONS = {
    "new_vlm": ("nemo_automodel.components.models.new_vlm.model", "NewVLMConfig"),
}
```

---

## supports_config Pattern

When a single HF architecture name maps to multiple possible backends (e.g., Mistral3 can be dense Ministral3 or MoE Mistral4), use `supports_config` to disambiguate:

```python
@classmethod
def supports_config(cls, config) -> bool:
    """Only handle configs whose text backbone is the expected type."""
    text_config = getattr(config, "text_config", None)
    return text_config is not None and getattr(text_config, "model_type", None) == "mistral4"
```

The registry calls `supports_config(config)` before returning the model class. If it returns `False`, the registry falls back to HF's default implementation.
