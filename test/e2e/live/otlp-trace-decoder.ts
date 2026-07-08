// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface OtlpAttributeArray extends ReadonlyArray<OtlpAttributeValue> {}

export interface OtlpAttributeMap {
  readonly [key: string]: OtlpAttributeValue;
}

export type OtlpAttributeValue =
  | string
  | number
  | boolean
  | null
  | OtlpAttributeArray
  | OtlpAttributeMap;

export type DecodedOtlpSpan = {
  attributes: Readonly<Record<string, OtlpAttributeValue>>;
  name: string;
  resourceAttributes: Readonly<Record<string, OtlpAttributeValue>>;
};

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const MAX_ANY_VALUE_DEPTH = 16;
const FORBIDDEN_ATTRIBUTE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function emptyAttributeMap(): Record<string, OtlpAttributeValue> {
  return Object.create(null) as Record<string, OtlpAttributeValue>;
}

class WireReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset === this.bytes.length;
  }

  readTag(): { field: number; wireType: number } {
    const tag = this.readVarint();
    const field = Number(tag >> 3n);
    const wireType = Number(tag & 0x07n);
    if (!Number.isSafeInteger(field) || field < 1) throw new Error("invalid protobuf field tag");
    return { field, wireType };
  }

  readVarint(): bigint {
    let result = 0n;
    for (let index = 0; index < 10; index += 1) {
      if (this.offset >= this.bytes.length) throw new Error("truncated protobuf varint");
      const byte = this.bytes[this.offset];
      this.offset += 1;
      result |= BigInt(byte & 0x7f) << BigInt(index * 7);
      if ((byte & 0x80) === 0) return result;
    }
    throw new Error("protobuf varint exceeds 10 bytes");
  }

  readBytes(): Uint8Array {
    const length = Number(this.readVarint());
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      throw new Error("truncated protobuf length-delimited field");
    }
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  readString(): string {
    return textDecoder.decode(this.readBytes());
  }

  readDouble(): number {
    if (this.offset + 8 > this.bytes.length) throw new Error("truncated protobuf double");
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8);
    const result = view.getFloat64(0, true);
    this.offset += 8;
    return result;
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.readVarint();
        return;
      case 1:
        this.skipBytes(8);
        return;
      case 2:
        this.readBytes();
        return;
      case 5:
        this.skipBytes(4);
        return;
      default:
        throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }

  private skipBytes(length: number): void {
    if (this.offset + length > this.bytes.length) throw new Error("truncated protobuf fixed field");
    this.offset += length;
  }
}

function expectWireType(actual: number, expected: number, field: string): void {
  if (actual !== expected) {
    throw new Error(`${field} uses protobuf wire type ${actual}, expected ${expected}`);
  }
}

function visitFields(
  bytes: Uint8Array,
  visit: (reader: WireReader, field: number, wireType: number) => boolean,
): void {
  const reader = new WireReader(bytes);
  while (!reader.done) {
    const { field, wireType } = reader.readTag();
    if (!visit(reader, field, wireType)) reader.skip(wireType);
  }
}

function signedInt64(value: bigint): number | string {
  const signed = value >= 1n << 63n ? value - (1n << 64n) : value;
  const number = Number(signed);
  return Number.isSafeInteger(number) ? number : signed.toString();
}

function decodeArrayValue(bytes: Uint8Array, depth: number): OtlpAttributeValue[] {
  const values: OtlpAttributeValue[] = [];
  visitFields(bytes, (reader, field, wireType) => {
    if (field !== 1) return false;
    expectWireType(wireType, 2, "ArrayValue.values");
    values.push(decodeAnyValue(reader.readBytes(), depth + 1));
    return true;
  });
  return values;
}

function addAttribute(
  attributes: Record<string, OtlpAttributeValue>,
  [key, value]: readonly [string, OtlpAttributeValue],
): void {
  if (FORBIDDEN_ATTRIBUTE_KEYS.has(key)) throw new Error(`forbidden OTLP attribute key ${key}`);
  if (Object.hasOwn(attributes, key)) throw new Error(`duplicate OTLP attribute key ${key}`);
  attributes[key] = value;
}

function decodeKeyValueList(bytes: Uint8Array, depth: number): Record<string, OtlpAttributeValue> {
  const attributes = emptyAttributeMap();
  visitFields(bytes, (reader, field, wireType) => {
    if (field !== 1) return false;
    expectWireType(wireType, 2, "KeyValueList.values");
    addAttribute(attributes, decodeKeyValue(reader.readBytes(), depth + 1));
    return true;
  });
  return attributes;
}

function decodeAnyValue(bytes: Uint8Array, depth = 0): OtlpAttributeValue {
  if (depth > MAX_ANY_VALUE_DEPTH) throw new Error("OTLP AnyValue nesting exceeds 16 levels");
  let value: OtlpAttributeValue | undefined;
  visitFields(bytes, (reader, field, wireType) => {
    if (field < 1 || field > 7) return false;
    if (value !== undefined) throw new Error("OTLP AnyValue contains multiple value variants");
    switch (field) {
      case 1:
        expectWireType(wireType, 2, "AnyValue.string_value");
        value = reader.readString();
        return true;
      case 2:
        expectWireType(wireType, 0, "AnyValue.bool_value");
        value = reader.readVarint() !== 0n;
        return true;
      case 3:
        expectWireType(wireType, 0, "AnyValue.int_value");
        value = signedInt64(reader.readVarint());
        return true;
      case 4:
        expectWireType(wireType, 1, "AnyValue.double_value");
        value = reader.readDouble();
        return true;
      case 5:
        expectWireType(wireType, 2, "AnyValue.array_value");
        value = decodeArrayValue(reader.readBytes(), depth);
        return true;
      case 6:
        expectWireType(wireType, 2, "AnyValue.kvlist_value");
        value = decodeKeyValueList(reader.readBytes(), depth);
        return true;
      case 7:
        expectWireType(wireType, 2, "AnyValue.bytes_value");
        value = Buffer.from(reader.readBytes()).toString("base64");
        return true;
      default:
        return false;
    }
  });
  return value ?? null;
}

function decodeKeyValue(bytes: Uint8Array, depth = 0): readonly [string, OtlpAttributeValue] {
  let key: string | undefined;
  let value: OtlpAttributeValue = null;
  visitFields(bytes, (reader, field, wireType) => {
    if (field === 1) {
      expectWireType(wireType, 2, "KeyValue.key");
      key = reader.readString();
      return true;
    }
    if (field === 2) {
      expectWireType(wireType, 2, "KeyValue.value");
      value = decodeAnyValue(reader.readBytes(), depth);
      return true;
    }
    return false;
  });
  if (key === undefined || key.length === 0) throw new Error("OTLP KeyValue is missing its key");
  return [key, value];
}

function decodeAttributes(
  bytes: Uint8Array,
  fieldNumber: number,
): Record<string, OtlpAttributeValue> {
  const attributes = emptyAttributeMap();
  visitFields(bytes, (reader, field, wireType) => {
    if (field !== fieldNumber) return false;
    expectWireType(wireType, 2, "repeated KeyValue attribute");
    addAttribute(attributes, decodeKeyValue(reader.readBytes()));
    return true;
  });
  return attributes;
}

function decodeSpan(bytes: Uint8Array): Omit<DecodedOtlpSpan, "resourceAttributes"> {
  let name = "";
  visitFields(bytes, (reader, field, wireType) => {
    if (field !== 5) return false;
    expectWireType(wireType, 2, "Span.name");
    name = reader.readString();
    return true;
  });
  return { name, attributes: decodeAttributes(bytes, 9) };
}

function decodeScopeSpans(bytes: Uint8Array): Omit<DecodedOtlpSpan, "resourceAttributes">[] {
  const spans: Omit<DecodedOtlpSpan, "resourceAttributes">[] = [];
  visitFields(bytes, (reader, field, wireType) => {
    if (field !== 2) return false;
    expectWireType(wireType, 2, "ScopeSpans.spans");
    spans.push(decodeSpan(reader.readBytes()));
    return true;
  });
  return spans;
}

function decodeResourceSpans(bytes: Uint8Array): DecodedOtlpSpan[] {
  let resourceAttributes = emptyAttributeMap();
  const spans: Omit<DecodedOtlpSpan, "resourceAttributes">[] = [];
  visitFields(bytes, (reader, field, wireType) => {
    if (field === 1) {
      expectWireType(wireType, 2, "ResourceSpans.resource");
      resourceAttributes = decodeAttributes(reader.readBytes(), 1);
      return true;
    }
    if (field === 2) {
      expectWireType(wireType, 2, "ResourceSpans.scope_spans");
      spans.push(...decodeScopeSpans(reader.readBytes()));
      return true;
    }
    return false;
  });
  return spans.map((span) => ({ ...span, resourceAttributes }));
}

export function decodeExportTraceServiceRequest(bytes: Uint8Array): DecodedOtlpSpan[] {
  const spans: DecodedOtlpSpan[] = [];
  visitFields(bytes, (reader, field, wireType) => {
    if (field !== 1) return false;
    expectWireType(wireType, 2, "ExportTraceServiceRequest.resource_spans");
    spans.push(...decodeResourceSpans(reader.readBytes()));
    return true;
  });
  if (spans.length === 0) throw new Error("OTLP request contains no spans");
  return spans;
}

export function otlpValueContains(value: OtlpAttributeValue | undefined, marker: string): boolean {
  if (typeof value === "string") return value.includes(marker);
  if (Array.isArray(value)) return value.some((item) => otlpValueContains(item, marker));
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((item) => otlpValueContains(item, marker));
  }
  return false;
}
