// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { StringDecoder } from "node:string_decoder";

export interface BoundedLineDecoderOptions {
  maxPendingChars: number;
  onLine: (line: string) => void;
}

/**
 * Decodes subprocess output without allowing a child that omits line breaks to
 * grow an unbounded pending string.
 */
export class BoundedLineDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private readonly maxPendingChars: number;
  private readonly onLine: (line: string) => void;
  private pending = "";
  private omittedPendingChars = 0;
  private skipLeadingLineFeed = false;
  private ended = false;

  constructor(options: BoundedLineDecoderOptions) {
    if (!Number.isInteger(options.maxPendingChars) || options.maxPendingChars < 1) {
      throw new Error("maxPendingChars must be a positive integer");
    }
    this.maxPendingChars = options.maxPendingChars;
    this.onLine = options.onLine;
  }

  write(chunk: Buffer | string): void {
    if (this.ended) throw new Error("cannot write after decoder end");
    this.consume(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
  }

  end(): void {
    if (this.ended) return;
    this.consume(this.decoder.end());
    this.skipLeadingLineFeed = false;
    if (this.pending || this.omittedPendingChars > 0) this.flushLine();
    this.ended = true;
  }

  private consume(text: string): void {
    if (!text) return;

    let start = 0;
    if (this.skipLeadingLineFeed) {
      this.skipLeadingLineFeed = false;
      if (text.startsWith("\n")) start = 1;
    }

    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (character !== "\r" && character !== "\n") continue;

      this.appendPending(text.slice(start, index));
      if (character === "\r" && index === text.length - 1) {
        this.flushLine();
        this.skipLeadingLineFeed = true;
        return;
      }

      this.flushLine();
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      start = index + 1;
    }

    this.appendPending(text.slice(start));
  }

  private appendPending(text: string): void {
    if (!text) return;
    if (text.length >= this.maxPendingChars) {
      this.omittedPendingChars += this.pending.length + text.length - this.maxPendingChars;
      this.pending = text.slice(-this.maxPendingChars);
      return;
    }

    this.pending += text;
    const overflow = this.pending.length - this.maxPendingChars;
    if (overflow > 0) {
      this.pending = this.pending.slice(overflow);
      this.omittedPendingChars += overflow;
    }
  }

  private flushLine(): void {
    const line =
      this.omittedPendingChars > 0
        ? `[NemoClaw] ${String(this.omittedPendingChars)} leading characters omitted from oversized output line: ${this.pending}`
        : this.pending;
    this.pending = "";
    this.omittedPendingChars = 0;
    this.onLine(line);
  }
}

export interface BoundedTextTranscriptOptions {
  maxChars: number;
  headChars?: number;
}

/** Keeps fixed-size leading and trailing evidence from a streamed transcript. */
export class BoundedTextTranscript {
  private readonly headChars: number;
  private readonly tailChars: number;
  private head = "";
  private tail = "";
  private totalChars = 0;

  constructor(options: BoundedTextTranscriptOptions) {
    if (!Number.isInteger(options.maxChars) || options.maxChars < 1) {
      throw new Error("maxChars must be a positive integer");
    }
    const headChars = options.headChars ?? Math.floor(options.maxChars / 4);
    if (!Number.isInteger(headChars) || headChars < 0 || headChars > options.maxChars) {
      throw new Error("headChars must be an integer between zero and maxChars");
    }
    this.headChars = headChars;
    this.tailChars = options.maxChars - headChars;
  }

  appendLine(line: string): void {
    this.append(`${line}\n`);
  }

  toString(): string {
    const omittedChars = this.totalChars - this.head.length - this.tail.length;
    const marker =
      omittedChars > 0
        ? `\n[NemoClaw] ${String(omittedChars)} transcript characters omitted.\n`
        : "";
    const output = `${this.head}${marker}${this.tail}`;
    return output.endsWith("\n") ? output.slice(0, -1) : output;
  }

  private append(text: string): void {
    if (!text) return;
    this.totalChars += text.length;

    const headRemaining = this.headChars - this.head.length;
    if (headRemaining > 0) {
      this.head += text.slice(0, headRemaining);
      text = text.slice(headRemaining);
    }
    if (!text || this.tailChars === 0) return;

    if (text.length >= this.tailChars) {
      this.tail = text.slice(-this.tailChars);
      return;
    }
    this.tail = `${this.tail}${text}`.slice(-this.tailChars);
  }
}
