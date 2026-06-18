# Complete Trace: nn.LSTM

This document traces the full implementation of `nn.LSTM` from the Python API down to CUDA/cuDNN kernels and the autograd backward pass.

**PyTorch version used:** v2.10.0 (paths may differ slightly across versions)

**Source note:** This trace summarizes PyTorch source structure and includes small illustrative excerpts from PyTorch. PyTorch is separately licensed; consult the upstream PyTorch repository and license for the original implementation.

## Overview

```
User code: nn.LSTM(input_size=256, hidden_size=512, num_layers=2)
    │
    ▼
Python Module: torch/nn/modules/rnn.py → class LSTM
    │
    ▼
Python Bridge: _VF.lstm() → torch._C._VariableFunctions.lstm
    │
    ▼
Dispatch: native_functions.yaml → lstm entry
    │
    ├── CPU path: aten/src/ATen/native/RNN.cpp → lstm()
    │
    └── CUDA path: aten/src/ATen/native/cudnn/RNN.cpp → cuDNN LSTM
    │
    ▼
Autograd: tools/autograd/derivatives.yaml → lstm backward
```

## Step 1: Python Module — `torch/nn/modules/rnn.py`

### Class Hierarchy

```python
# torch/nn/modules/rnn.py

class RNNBase(Module):
    """Base class for all RNN modules (RNN, LSTM, GRU)."""

    def __init__(self, mode, input_size, hidden_size, num_layers=1,
                 bias=True, batch_first=False, dropout=0.,
                 bidirectional=False, ...):
        super().__init__()
        self.mode = mode          # 'LSTM', 'GRU', 'RNN_TANH', 'RNN_RELU'
        self.input_size = input_size
        self.hidden_size = hidden_size
        self.num_layers = num_layers
        # ... stores all configuration

        # Creates weight parameters:
        # weight_ih_l{layer}: input-hidden weights
        # weight_hh_l{layer}: hidden-hidden weights
        # bias_ih_l{layer}: input-hidden bias
        # bias_hh_l{layer}: hidden-hidden bias
        for layer in range(num_layers):
            for direction in range(num_directions):
                # Register Parameter for each weight matrix
                ...

class LSTM(RNNBase):
    """Long Short-Term Memory (LSTM) RNN."""

    def __init__(self, *args, **kwargs):
        super().__init__('LSTM', *args, **kwargs)
        # mode='LSTM' tells RNNBase to create LSTM-specific weights
```

### forward() Method

The key computation happens in `RNNBase.forward()` (inherited by LSTM):

```python
class RNNBase(Module):
    def forward(self, input, hx=None):
        # 1. Handle batch_first: transpose if needed
        if self.batch_first:
            input = input.transpose(0, 1)  # (B, T, F) → (T, B, F)

        # 2. Initialize hidden state if not provided
        if hx is None:
            h_zeros = torch.zeros(self.num_layers * num_directions,
                                  batch_size, self.hidden_size,
                                  dtype=input.dtype, device=input.device)
            if self.mode == 'LSTM':
                hx = (h_zeros, h_zeros)  # (h_0, c_0)
            else:
                hx = h_zeros

        # 3. Flatten weights for cuDNN compatibility
        self._flat_weights = [getattr(self, wn) for wn in self._flat_weights_names]

        # 4. Call the C++ implementation via _VF bridge
        if self.mode == 'LSTM':
            result = _VF.lstm(input, hx, self._flat_weights, self.bias,
                              self.num_layers, self.dropout, self.training,
                              self.bidirectional, self.batch_first)
        # ...

        output = result[0]
        hidden = result[1:]

        # 5. Handle batch_first: transpose output back
        if self.batch_first:
            output = output.transpose(0, 1)

        return output, hidden
```

**Key takeaway:** The Python module handles:
- Input shape management (batch_first)
- Default hidden state initialization
- Weight flattening for cuDNN
- Delegating to `_VF.lstm()` for actual computation

## Step 2: Python-C++ Bridge — `_VF.lstm`

```python
# torch/_VF.py
# _VF provides access to torch._C._VariableFunctions
# _VF.lstm routes to torch._C._VariableFunctions.lstm
```

The `_VF.lstm()` call goes directly to the C++ dispatcher. There is no Python implementation of the LSTM algorithm — it's all in C++.

## Step 3: Dispatch — `native_functions.yaml`

Search for `lstm` in `aten/src/ATen/native/native_functions.yaml`:

```yaml
- func: lstm.input(Tensor input, Tensor[] hx, Tensor[] params, bool has_biases, int num_layers, float dropout, bool train, bool bidirectional, bool batch_first) -> (Tensor, Tensor, Tensor)
  dispatch:
    CompositeExplicitAutograd: lstm

- func: lstm.data(Tensor data, Tensor batch_sizes, Tensor[] hx, Tensor[] params, bool has_biases, int num_layers, float dropout, bool train, bool bidirectional) -> (Tensor, Tensor, Tensor)
  dispatch:
    CompositeExplicitAutograd: lstm
```

**Key observations:**
- Two overloads: one for padded input (`lstm.input`), one for packed sequences (`lstm.data`)
- Returns 3 tensors: `(output, h_n, c_n)`
- `CompositeExplicitAutograd` dispatch: single implementation that works on all backends, with explicit autograd handling
- The implementation function is named `lstm` in C++

## Step 4: C++ Implementation — `aten/src/ATen/native/RNN.cpp`

The main C++ file is `aten/src/ATen/native/RNN.cpp`:

```cpp
// aten/src/ATen/native/RNN.cpp

std::tuple<Tensor, Tensor, Tensor> lstm(
    const Tensor& input,
    TensorList hx,
    TensorList params,
    bool has_biases,
    int64_t num_layers,
    double dropout,
    bool train,
    bool bidirectional,
    bool batch_first
) {
    // Check if cuDNN is available and appropriate
    if (use_cudnn(input, params)) {
        // Use cuDNN fast path
        return std::get<0>(at::native::lstm_cudnn(
            input, hx, params, has_biases,
            num_layers, dropout, train, bidirectional, batch_first
        ));
    }

    // Fall back to native implementation
    // ... calls lstm_impl() which uses cell-level operations
}
```

### Decision Logic

The C++ implementation makes a runtime decision:
1. **If cuDNN available** (CUDA device, suitable parameters, cuDNN enabled): use cuDNN
2. **Otherwise**: use the native C++ implementation with explicit loops over time steps

### Native (non-cuDNN) Implementation

For the native path, LSTM is decomposed into cell operations:

```cpp
// Simplified from aten/src/ATen/native/RNN.cpp

// Single LSTM cell computation:
// gates = input @ W_ih^T + hidden @ W_hh^T + bias
// i, f, g, o = gates.chunk(4)    // Split into 4 gates
// c_next = sigmoid(f) * c + sigmoid(i) * tanh(g)
// h_next = sigmoid(o) * tanh(c_next)
```

This loops over:
- Each time step (sequence length)
- Each layer
- Each direction (if bidirectional)

## Step 5: CUDA/cuDNN — `aten/src/ATen/native/cudnn/RNN.cpp`

When cuDNN is used (the fast path for CUDA), the implementation is in:

```cpp
// aten/src/ATen/native/cudnn/RNN.cpp

std::tuple<Tensor, Tensor, Tensor, Tensor, Tensor> lstm_cudnn(
    const Tensor& input,
    TensorList hx,
    TensorList params,
    bool has_biases,
    int64_t num_layers,
    double dropout,
    bool train,
    bool bidirectional,
    bool batch_first
) {
    // 1. Create cuDNN RNN descriptor
    RNNDescriptorParams rnn_desc_params;
    rnn_desc_params.set(
        CUDNN_LSTM,           // RNN mode
        hidden_size,
        num_layers,
        bidirectional,
        ...
    );

    // 2. Set up tensor descriptors for input/output/hidden
    TensorDescriptor xDesc, yDesc, hxDesc, hyDesc, cxDesc, cyDesc;

    // 3. Get workspace size from cuDNN
    size_t workspaceSize;
    cudnnGetRNNWorkspaceSize(handle, rnnDesc, seqLength, xDescs, &workspaceSize);

    // 4. Allocate workspace and reserve space
    Tensor workspace = at::empty({workspaceSize}, ...);
    Tensor reserveSpace = at::empty({reserveSize}, ...);

    // 5. Execute cuDNN LSTM forward
    cudnnRNNForward(           // or cudnnRNNForwardTraining
        handle,
        rnnDesc,
        seqLength,
        xDescs, input.data_ptr(),
        hxDesc, hx.data_ptr(),
        cxDesc, cx.data_ptr(),
        wDesc, weight.data_ptr(),
        yDescs, output.data_ptr(),
        hyDesc, hy.data_ptr(),
        cyDesc, cy.data_ptr(),
        workspace.data_ptr(), workspaceSize,
        reserveSpace.data_ptr(), reserveSize
    );

    return {output, hy, cy, reserveSpace, weight_buf};
}
```

**Key observations:**
- cuDNN handles the entire multi-layer, bidirectional LSTM in a single call
- `reserveSpace` stores intermediate values needed for backward (saves recomputation)
- cuDNN internally fuses gates and optimizes memory access patterns
- This is significantly faster than the cell-by-cell native implementation

### cuDNN Backward

```cpp
// Also in aten/src/ATen/native/cudnn/RNN.cpp

std::tuple<Tensor, Tensor, Tensor, std::vector<Tensor>> lstm_backward_cudnn(
    const Tensor& grad_output,
    const Tensor& grad_hy,
    const Tensor& grad_cy,
    ...
    const Tensor& reserveSpace   // From forward pass
) {
    // 1. cudnnRNNBackwardData — computes grad_input, grad_hx, grad_cx
    cudnnRNNBackwardData(handle, rnnDesc, ...);

    // 2. cudnnRNNBackwardWeights — computes grad_weights
    cudnnRNNBackwardWeights(handle, rnnDesc, ...);

    return {grad_input, grad_hx, grad_cx, grad_weights};
}
```

## Step 6: Autograd — `tools/autograd/derivatives.yaml`

Search `derivatives.yaml` for the LSTM backward formula:

```yaml
# tools/autograd/derivatives.yaml

- name: lstm(Tensor input, Tensor[] hx, Tensor[] params, bool has_biases, int num_layers, float dropout, bool train, bool bidirectional, bool batch_first) -> (Tensor, Tensor, Tensor)
  input, hx, params: "lstm_backward(...)"
```

For LSTM, the backward pass is handled by a custom backward function rather than a simple formula, because:
1. The backward needs the `reserveSpace` saved during forward
2. cuDNN backward requires special API calls
3. The gradient computation is complex (multi-layer, bidirectional)

The actual backward implementation dispatches back to either:
- `lstm_backward_cudnn()` in `aten/src/ATen/native/cudnn/RNN.cpp` (CUDA path)
- A native backward in `aten/src/ATen/native/RNN.cpp` (CPU path)

## Summary Table

| Layer | File | Key Function/Class |
|-------|------|--------------------|
| Python Module | `torch/nn/modules/rnn.py` | `class LSTM(RNNBase)` → `forward()` |
| Python Bridge | `torch/_VF.py` | `_VF.lstm()` → `torch._C._VariableFunctions.lstm` |
| Dispatch Config | `aten/src/ATen/native/native_functions.yaml` | `lstm.input` entry |
| C++ Entry | `aten/src/ATen/native/RNN.cpp` | `lstm()` → decides cuDNN vs native |
| cuDNN Forward | `aten/src/ATen/native/cudnn/RNN.cpp` | `lstm_cudnn()` → `cudnnRNNForward()` |
| cuDNN Backward | `aten/src/ATen/native/cudnn/RNN.cpp` | `lstm_backward_cudnn()` |
| Native Forward | `aten/src/ATen/native/RNN.cpp` | Cell-level loop implementation |
| Autograd | `tools/autograd/derivatives.yaml` | `lstm` backward entry |

## Performance Notes

- **cuDNN path** is much faster than native path due to:
  - Fused gate computations
  - Optimized memory access patterns
  - cuDNN's internal tensor core utilization (on Volta+)
- **Native path** is used when:
  - Running on CPU
  - cuDNN is disabled (`torch.backends.cudnn.enabled = False`)
  - Input/parameters don't meet cuDNN requirements
- **Dropout** in multi-layer LSTM: applied between layers (not within a layer), and cuDNN handles this internally with the `reserveSpace` buffer
