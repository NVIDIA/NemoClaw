<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. SPDX-License-Identifier: CC-BY-4.0 -->
# cuPyNumeric API support

Source: https://nv-legate.github.io/cupynumeric/api/comparison.html
Fetched: 2026-05-22T15:45:33+00:00
Counts: 616 total · 412 implemented · 363 multi-GPU · 9 single-GPU only · 14 partial · 204 not implemented

Legend

- `✓✓` implemented and works on multi-GPU (the best path; implies single-GPU)
- `✓` implemented but single-GPU/CPU only (caveats multi-node)
- `🟡` partial support — see the per-line note
- `✗` not implemented on the cuPyNumeric distributed path. Behavior on call is version-specific (some unsupported APIs route through host NumPy, others raise an exception) — either way, hot-path use is a migration blocker

The cuPyNumeric name is `cupynumeric.<tail>` of the NumPy name (e.g. `numpy.fft.fft` ↔ `cupynumeric.fft.fft`).

## Module-Level (290 of 454 implemented)

✓✓ numpy.absolute, numpy.acos, numpy.acosh, numpy.add, numpy.all, numpy.allclose, numpy.amax, numpy.amin, numpy.angle
✓✓ numpy.any, numpy.append, numpy.arange, numpy.arccos, numpy.arccosh, numpy.arcsin, numpy.arcsinh, numpy.arctan
✓✓ numpy.arctan2, numpy.arctanh, numpy.argmax, numpy.argmin, numpy.argpartition, numpy.argsort, numpy.argwhere
✓✓ numpy.array, numpy.array_equal, numpy.array_split, numpy.asarray, numpy.asin, numpy.asinh, numpy.atan, numpy.atanh
✓✓ numpy.atleast_1d, numpy.atleast_2d, numpy.atleast_3d, numpy.average, numpy.bartlett, numpy.bincount
✓✓ numpy.bitwise_and, numpy.bitwise_or, numpy.bitwise_xor, numpy.blackman, numpy.block, numpy.broadcast_arrays
✓✓ numpy.broadcast_shapes, numpy.broadcast_to, numpy.cbrt, numpy.ceil, numpy.choose, numpy.clip, numpy.column_stack
✓✓ numpy.compress, numpy.concat, numpy.concatenate, numpy.conj, numpy.conjugate, numpy.convolve, numpy.copy
✓✓ numpy.copysign, numpy.copyto, numpy.cos, numpy.cosh, numpy.count_nonzero, numpy.cov, numpy.cross, numpy.cumprod
✓✓ numpy.cumsum, numpy.deg2rad, numpy.degrees, numpy.delete, numpy.diag, numpy.diag_indices, numpy.diag_indices_from
✓✓ numpy.diagflat, numpy.diagonal, numpy.diff, numpy.digitize, numpy.divide, numpy.dot, numpy.dsplit, numpy.dstack
✓✓ numpy.einsum, numpy.einsum_path, numpy.empty, numpy.empty_like, numpy.equal, numpy.exp, numpy.exp2, numpy.expand_dims
✓✓ numpy.expm1, numpy.extract, numpy.eye, numpy.fabs, numpy.fill_diagonal, numpy.flatnonzero, numpy.float_power
✓✓ numpy.floor, numpy.floor_divide, numpy.fmax, numpy.fmin, numpy.fmod, numpy.frexp, numpy.full, numpy.full_like
✓✓ numpy.gcd, numpy.gradient, numpy.greater, numpy.greater_equal, numpy.hamming, numpy.hanning, numpy.histogram
✓✓ numpy.histogram2d, numpy.histogramdd, numpy.hsplit, numpy.hstack, numpy.hypot, numpy.identity, numpy.imag
✓✓ numpy.indices, numpy.inner, numpy.insert, numpy.invert, numpy.isclose, numpy.iscomplex, numpy.iscomplexobj
✓✓ numpy.isfinite, numpy.isin, numpy.isinf, numpy.isnan, numpy.isneginf, numpy.isposinf, numpy.isreal, numpy.isrealobj
✓✓ numpy.isscalar, numpy.ix\_, numpy.kaiser, numpy.lcm, numpy.ldexp, numpy.left_shift, numpy.less, numpy.less_equal
✓✓ numpy.lexsort, numpy.linspace, numpy.log, numpy.log10, numpy.log1p, numpy.log2, numpy.logaddexp, numpy.logaddexp2
✓✓ numpy.logical_and, numpy.logical_not, numpy.logical_or, numpy.logical_xor, numpy.logspace, numpy.mask_indices
✓✓ numpy.matmul, numpy.maximum, numpy.mean, numpy.median, numpy.meshgrid, numpy.minimum, numpy.mod, numpy.modf
✓✓ numpy.moveaxis, numpy.multiply, numpy.nan_to_num, numpy.nanargmax, numpy.nanargmin, numpy.nancumprod, numpy.nancumsum
✓✓ numpy.nanmax, numpy.nanmean, numpy.nanmedian, numpy.nanmin, numpy.nanpercentile, numpy.nanprod, numpy.nanquantile
✓✓ numpy.nansum, numpy.ndim, numpy.negative, numpy.nextafter, numpy.nonzero, numpy.not_equal, numpy.ones
✓✓ numpy.ones_like, numpy.outer, numpy.packbits, numpy.pad, numpy.partition, numpy.percentile, numpy.permute_dims
✓✓ numpy.place, numpy.positive, numpy.power, numpy.prod, numpy.put, numpy.put_along_axis, numpy.putmask, numpy.quantile
✓✓ numpy.rad2deg, numpy.radians, numpy.ravel, numpy.real, numpy.real_if_close, numpy.reciprocal, numpy.remainder
✓✓ numpy.repeat, numpy.reshape, numpy.right_shift, numpy.rint, numpy.roll, numpy.row_stack, numpy.searchsorted
✓✓ numpy.select, numpy.shape, numpy.sign, numpy.signbit, numpy.sin, numpy.sinh, numpy.sort, numpy.sort_complex
✓✓ numpy.split, numpy.sqrt, numpy.square, numpy.squeeze, numpy.stack, numpy.subtract, numpy.sum, numpy.swapaxes
✓✓ numpy.take, numpy.take_along_axis, numpy.tan, numpy.tanh, numpy.tensordot, numpy.tile, numpy.trace, numpy.transpose
✓✓ numpy.tri, numpy.tril, numpy.tril_indices, numpy.tril_indices_from, numpy.triu, numpy.triu_indices
✓✓ numpy.triu_indices_from, numpy.true_divide, numpy.trunc, numpy.unique, numpy.unpackbits, numpy.unravel_index
✓✓ numpy.var, numpy.vdot, numpy.vsplit, numpy.vstack, numpy.where, numpy.zeros, numpy.zeros_like
✓ numpy.flip, numpy.fliplr, numpy.flipud, numpy.roots, numpy.rot90
✗ numpy.apply_along_axis, numpy.apply_over_axes, numpy.around, numpy.array2string, numpy.array_equiv, numpy.array_repr
✗ numpy.array_str, numpy.asanyarray, numpy.asarray_chkfinite, numpy.ascontiguousarray, numpy.asfortranarray
✗ numpy.asmatrix, numpy.astype, numpy.atan2, numpy.base_repr, numpy.binary_repr, numpy.bitwise_count
✗ numpy.bitwise_invert, numpy.bitwise_left_shift, numpy.bitwise_right_shift, numpy.bmat, numpy.bool, numpy.busday_count
✗ numpy.busday_offset, numpy.busdaycalendar, numpy.byte, numpy.bytes\_, numpy.can_cast, numpy.cdouble, numpy.character
✗ numpy.clongdouble, numpy.common_type, numpy.complex256, numpy.corrcoef, numpy.correlate, numpy.csingle
✗ numpy.cumulative_prod, numpy.cumulative_sum, numpy.datetime64, numpy.datetime_as_string, numpy.datetime_data
✗ numpy.divmod, numpy.double, numpy.ediff1d, numpy.errstate, numpy.fix, numpy.flatiter, numpy.flexible, numpy.float128
✗ numpy.format_float_positional, numpy.format_float_scientific, numpy.frombuffer, numpy.fromfile, numpy.fromfunction
✗ numpy.fromiter, numpy.frompyfunc, numpy.fromregex, numpy.fromstring, numpy.generic, numpy.genfromtxt, numpy.geomspace
✗ numpy.get_include, numpy.get_printoptions, numpy.getbufsize, numpy.geterr, numpy.geterrcall, numpy.half
✗ numpy.heaviside, numpy.histogram_bin_edges, numpy.i0, numpy.info, numpy.int\_, numpy.intc, numpy.interp
✗ numpy.intersect1d, numpy.intp, numpy.is_busday, numpy.isdtype, numpy.isfortran, numpy.isnat, numpy.issubdtype
✗ numpy.kron, numpy.loadtxt, numpy.long, numpy.longdouble, numpy.longlong, numpy.matrix, numpy.matrix_transpose
✗ numpy.matvec, numpy.may_share_memory, numpy.memmap, numpy.min_scalar_type, numpy.mintypecode, numpy.nanstd
✗ numpy.nanvar, numpy.ndenumerate, numpy.ndindex, numpy.nditer, numpy.nested_iters, numpy.number, numpy.object\_
✗ numpy.piecewise, numpy.poly, numpy.poly1d, numpy.polyadd, numpy.polyder, numpy.polydiv, numpy.polyfit, numpy.polyint
✗ numpy.polymul, numpy.polysub, numpy.polyval, numpy.pow, numpy.printoptions, numpy.promote_types, numpy.ptp
✗ numpy.recarray, numpy.record, numpy.require, numpy.resize, numpy.result_type, numpy.rollaxis, numpy.save
✗ numpy.savetxt, numpy.savez, numpy.savez_compressed, numpy.set_printoptions, numpy.setbufsize, numpy.setdiff1d
✗ numpy.seterr, numpy.seterrcall, numpy.setxor1d, numpy.shares_memory, numpy.short, numpy.show_config
✗ numpy.show_runtime, numpy.sinc, numpy.single, numpy.spacing, numpy.std, numpy.str\_, numpy.timedelta64
✗ numpy.trapezoid, numpy.trim_zeros, numpy.typename, numpy.ubyte, numpy.uint, numpy.uintc, numpy.uintp, numpy.ulong
✗ numpy.ulonglong, numpy.union1d, numpy.unique_all, numpy.unique_counts, numpy.unique_inverse, numpy.unique_values
✗ numpy.unstack, numpy.unwrap, numpy.ushort, numpy.vander, numpy.vecdot, numpy.vecmat, numpy.vectorize, numpy.void

## Multi-Dimensional Array (46 of 50 implemented)

✓✓ numpy.ndarray.all(), numpy.ndarray.any(), numpy.ndarray.argmax(), numpy.ndarray.argmin()
✓✓ numpy.ndarray.argpartition(), numpy.ndarray.argsort(), numpy.ndarray.astype(), numpy.ndarray.choose()
✓✓ numpy.ndarray.clip(), numpy.ndarray.compress(), numpy.ndarray.conj(), numpy.ndarray.conjugate(), numpy.ndarray.copy()
✓✓ numpy.ndarray.diagonal(), numpy.ndarray.dot(), numpy.ndarray.dumps(), numpy.ndarray.fill(), numpy.ndarray.flatten()
✓✓ numpy.ndarray.item(), numpy.ndarray.mean(), numpy.ndarray.nonzero(), numpy.ndarray.partition(), numpy.ndarray.prod()
✓✓ numpy.ndarray.put(), numpy.ndarray.ravel(), numpy.ndarray.reshape(), numpy.ndarray.searchsorted()
✓✓ numpy.ndarray.setflags(), numpy.ndarray.sort(), numpy.ndarray.squeeze(), numpy.ndarray.sum()
✓✓ numpy.ndarray.swapaxes(), numpy.ndarray.take(), numpy.ndarray.tobytes(), numpy.ndarray.tolist()
✓✓ numpy.ndarray.trace(), numpy.ndarray.transpose(), numpy.ndarray.var(), numpy.ndarray.view()
✗ numpy.ndarray.byteswap(), numpy.ndarray.repeat(), numpy.ndarray.resize(), numpy.ndarray.std()

## Linear Algebra (15 of 32 implemented)

✓✓ numpy.linalg.cholesky, numpy.linalg.eig, numpy.linalg.eigh, numpy.linalg.eigvals, numpy.linalg.eigvalsh
✓✓ numpy.linalg.matmul, numpy.linalg.matrix_power, numpy.linalg.multi_dot, numpy.linalg.norm, numpy.linalg.solve
✓ numpy.linalg.inv, numpy.linalg.pinv, numpy.linalg.qr, numpy.linalg.svd
✗ numpy.linalg.cond, numpy.linalg.cross, numpy.linalg.det, numpy.linalg.diagonal, numpy.linalg.lstsq
✗ numpy.linalg.matrix_norm, numpy.linalg.matrix_rank, numpy.linalg.matrix_transpose, numpy.linalg.outer
✗ numpy.linalg.slogdet, numpy.linalg.svdvals, numpy.linalg.tensordot, numpy.linalg.tensorinv, numpy.linalg.tensorsolve
✗ numpy.linalg.trace, numpy.linalg.vecdot, numpy.linalg.vector_norm

## Discrete Fourier Transform (16 of 18 implemented)

✓✓ numpy.fft.fftshift, numpy.fft.ifftshift
🟡 numpy.fft.fft — multi-GPU partial: data-parallel axis-wise batching only
🟡 numpy.fft.fft2 — multi-GPU partial: data-parallel axis-wise batching only
🟡 numpy.fft.fftn — multi-GPU partial: data-parallel axis-wise batching only
🟡 numpy.fft.hfft — multi-GPU partial: data-parallel axis-wise batching only
🟡 numpy.fft.ifft — multi-GPU partial: data-parallel axis-wise batching only
🟡 numpy.fft.ifft2 — multi-GPU partial: data-parallel axis-wise batching only
🟡 numpy.fft.ifftn — multi-GPU partial: data-parallel axis-wise batching only
🟡 numpy.fft.ihfft — multi-GPU partial: data-parallel axis-wise batching only
🟡 numpy.fft.irfft — multi-GPU partial: data-parallel axis-wise batching only
🟡 numpy.fft.irfft2 — multi-GPU partial: data-parallel axis-wise batching only
🟡 numpy.fft.irfftn — multi-GPU partial: data-parallel axis-wise batching only
🟡 numpy.fft.rfft — multi-GPU partial: data-parallel axis-wise batching only
🟡 numpy.fft.rfft2 — multi-GPU partial: data-parallel axis-wise batching only
🟡 numpy.fft.rfftn — multi-GPU partial: data-parallel axis-wise batching only
✗ numpy.fft.fftfreq, numpy.fft.rfftfreq

## Random Sampling (45 of 62 implemented)

✓✓ numpy.random.beta, numpy.random.binomial, numpy.random.bytes, numpy.random.chisquare, numpy.random.default_rng
✓✓ numpy.random.exponential, numpy.random.f, numpy.random.gamma, numpy.random.geometric, numpy.random.gumbel
✓✓ numpy.random.hypergeometric, numpy.random.laplace, numpy.random.logistic, numpy.random.lognormal
✓✓ numpy.random.logseries, numpy.random.negative_binomial, numpy.random.noncentral_chisquare, numpy.random.noncentral_f
✓✓ numpy.random.normal, numpy.random.pareto, numpy.random.poisson, numpy.random.power, numpy.random.rand
✓✓ numpy.random.randint, numpy.random.randn, numpy.random.random, numpy.random.random_integers
✓✓ numpy.random.random_sample, numpy.random.ranf, numpy.random.rayleigh, numpy.random.sample, numpy.random.seed
✓✓ numpy.random.standard_cauchy, numpy.random.standard_exponential, numpy.random.standard_gamma, numpy.random.standard_t
✓✓ numpy.random.triangular, numpy.random.uniform, numpy.random.vonmises, numpy.random.wald, numpy.random.weibull
✓✓ numpy.random.zipf
✗ numpy.random.MT19937, numpy.random.PCG64, numpy.random.PCG64DXSM, numpy.random.Philox, numpy.random.SFC64
✗ numpy.random.SeedSequence, numpy.random.choice, numpy.random.dirichlet, numpy.random.get_bit_generator
✗ numpy.random.get_state, numpy.random.multinomial, numpy.random.multivariate_normal, numpy.random.permutation
✗ numpy.random.set_bit_generator, numpy.random.set_state, numpy.random.shuffle, numpy.random.standard_normal
