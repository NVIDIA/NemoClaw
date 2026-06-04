// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {describe, expect, it} from 'vitest';
import {shellQuote} from './shell-quote';

describe('shellQuote', () => {
    it("wraps a simple string in single quotes", () => {
        expect(shellQuote("hello world")).toBe("'hello world'");
    });

    it("wraps a plain word with no special characters", () => {
        expect(shellQuote("hello")).toBe("'hello'");
    });

    it("escapes embedded single quotes", () => {
        expect(shellQuote("it's a test")).toBe("'it'\\''s a test'");
    });

    it("handles empty string", () => {
        expect(shellQuote("")).toBe("''");
    });

    it("handles words with special characters", () => {
        expect(shellQuote("hello$world")).toBe("'hello$world'");
    });
    it("handles strings with only single quotes", () => {
        expect(shellQuote("''")).toBe("''\\'''\\'''");
    });
})
