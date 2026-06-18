## List of test examples for Convolution

For Convolution parameters, the following can be either a single value or a tuple of values and you should generate the code accordingly.
- kernel_size: The size of the kernel, either a single value or a tuple of values.
    + The single value means the size of the kernel is the same for all dimensions.
    + The tuple of values means the size of the kernel is different for each dimension.
- stride: stride of the convolution.
- padding: padding of the convolution.
- dilation: dilation of the convolution.
- output_padding: controls the additional size added to one side of the output shape, not actually padding (only in convolution transpose)
- bias: bias of the convolution (default: True)

**Important**: Avoid using cuTile's tile size (1, 1) for 2D convolution or (1, 1, 1) for 3D convolution as it is inefficient. Use larger kernel sizes as shown in the following examples.

**Steps for Converting PyTorch Convolution to cuTile**:

1. **Identify Convolution Type and Dimension**:
   - Determine if it's regular convolution (`torch.nn.Conv1d`, `torch.nn.Conv2d`, `torch.nn.Conv3d`) or transpose convolution (`torch.nn.ConvTranspose1d`, `torch.nn.ConvTranspose2d`, `torch.nn.ConvTranspose3d`)
   - Extract the dimension (1D, 2D, or 3D) from the layer type

2. **Extract Convolution Parameters**:
   - **Model attributes**: Access parameters like `model.conv.in_channels`, `model.conv.out_channels`, and `model.conv.kernel_size`.
   - **Weight tensor**: Use `model.conv.weight.data` to get the actual weight values
   - **Bias tensor**: Use `model.conv.bias.data` if bias is enabled (bias is enabled by default) this is different from `model.bias.data` which is the bias of the model.

3. **Distinguish Parameter Types**:
   - **Model parameters**: Direct model attributes like `model.bias.data` (model bias)
   - **Layer parameters**: Convolution-specific parameters like `model.conv.weight.data`, `model.conv.bias.data` (conv bias)
   - **Computed parameters**: Derived values like `in_channels_per_group = in_channels // groups`

4. **Implement cuTile Kernel Considerations**:
   - **Regular Convolution**: Use forward convolution logic with proper indexing for input gathering
   - **Power-of-2 Padding**: Use `next_power_of_2()` for efficient cuTile operations
   - **Masking**: Apply proper bounds checking and padding for out-of-bounds access

5. **Grid and Block Configuration**:
   - Set up appropriate grid dimensions based on output tensor shape
   - Handle grouped convolutions by computing per-group channel ranges

## Examples

- [2D convolution with bias, dilation, and groups](conv2d_with_bias_dilation_groups.py)
- [3D convolution with bias, dilation, and groups](conv3d_with_bias_dilation_groups.py)
- [2D convolution transpose with bias, dilation, groups, and output_padding](conv_transpose_2d.py)
- [3D convolution transpose with bias, dilation, groups, and output_padding](conv_transpose_3d.py)
