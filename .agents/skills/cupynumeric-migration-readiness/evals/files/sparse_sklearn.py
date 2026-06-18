# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
from collections import Counter

import numpy as np
from scipy import sparse
from sklearn.metrics.pairwise import cosine_similarity


def majority_vote(labels):
    return Counter(np.asarray(labels).tolist()).most_common(1)[0][0]


def tag_sequences(sequences, vocab, labels):
    rows, cols, vals = [], [], []
    for i, seq in enumerate(sequences):
        for token in seq:
            if token in vocab:
                rows.append(i)
                cols.append(vocab[token])
                vals.append(1.0)
    tf = sparse.csr_matrix(
        (vals, (rows, cols)), shape=(len(sequences), len(vocab))
    )

    sim = cosine_similarity(tf)

    labels = np.asarray(labels)
    tags = []
    for i in range(len(sequences)):
        nearest = np.argsort(sim[i])[-5:]
        tags.append(majority_vote(labels[nearest]))
    return tags
