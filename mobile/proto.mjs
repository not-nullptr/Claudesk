// Protobuf wire codec for the Recovered Claude mobile Connect surfaces,
// driven by docs/mobile-spec/Claude-Mobile-Proto-Schema-1.260925.19.json.
//
// Field entries look like:
//   { number, proto: "snake_case", json: "camelCase"|"", repeated, type }
// where `type` is a scalar name (string/bool/int64/…), a schema enum name
// (e.g. "BardRole"), a schema message name, or one of the standalone Google
// well-known types that are referenced but not enumerated in the schema.
//
// For buffering we mostly care about JSON-in/proto-out: the adapter keeps a
// canonical JSON object per message and this codec is only used when the
// client speaks application/connect+proto (or application/proto). Timestamps
// are translated ISO-8601 <-> {seconds, nanos} transparently because the
// schema does not include Google_Protobuf_Timestamp itself.

import { readFile } from "node:fs/promises";

export async function loadSchema(schemaPath) {
  return JSON.parse(await readFile(schemaPath, "utf8"));
}

// Buffers well-known Google protobuf message names that the schema references
// without defining. Only what the handled surfaces encode matters.
const syntheticDefs = {
  Google_Protobuf_Timestamp: {
    kind: "message",
    fields: [
      { number: 1, proto: "seconds", json: "seconds", repeated: false, type: "int64" },
      { number: 2, proto: "nanos", json: "nanos", repeated: false, type: "int32" },
    ],
  },
  Google_Protobuf_Struct: {
    kind: "message",
    fields: [],
  },
  Google_Protobuf_Any: {
    kind: "message",
    fields: [],
  },
};

function lookup(schema, name) {
  return schema[name] || syntheticDefs[name] || null;
}

function wireTypeFor(schema, field, type) {
  switch (type) {
    case "string":
    case "bytes":
      return 2;
    case "double":
    case "fixed64":
    case "sfixed64":
      return 1;
    case "float":
    case "fixed32":
    case "sfixed32":
      return 5;
    case "bool":
    case "int32":
    case "int64":
    case "uint32":
    case "uint64":
    case "sint32":
    case "sint64":
    case "enum":
    case "unresolved":
      return 0;
    default:
      if (lookup(schema, type)?.kind === "message") return 2;
      return 0;
  }
}

function encodeVarint(value, output) {
  let n = BigInt.asUintN(64, BigInt(value));
  for (;;) {
    const byte = Number(n & 0x7fn);
    const next = n >> 7n;
    if (next === 0n) {
      output.push(byte);
      return;
    }
    output.push(byte | 0x80);
    n = next;
  }
}

function readVarint(buffer, offset) {
  let shift = 0n;
  let value = 0n;
  for (let index = offset; index < buffer.length; index += 1) {
    const byte = buffer[index];
    value |= BigInt(byte & 0x7f) << BigInt(shift);
    if (!(byte & 0x80)) return [value, index + 1];
    shift += 7;
    if (shift > 70) throw new Error("varint too long");
  }
  throw new Error("truncated varint");
}

function zigzagDecode(value) {
  const raw = BigInt.asUintN(64, BigInt(value));
  return Number(raw >> 1n) ^ -Number(raw & 1n);
}

function zigzagEncode(value) {
  const n = BigInt(Math.trunc(Number(value)));
  return (n << 1n) ^ (n >> 63n);
}

function timestampParts(value) {
  let ms;
  if (typeof value === "string") {
    ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new Error(`invalid ISO timestamp: ${value}`);
  } else if (typeof value === "number") {
    ms = value;
  } else {
    ms = Number(value?.seconds || 0) * 1000 + Math.floor(Number(value?.nanos || 0) / 1e6);
  }
  return { seconds: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6 };
}

function encodeTimestampBuffer(value) {
  const { seconds, nanos } = timestampParts(value);
  return encodeProto(GOOGLE_TIMESTAMP_SCHEMA, "Google_Protobuf_Timestamp", { seconds, nanos });
}

const GOOGLE_TIMESTAMP_SCHEMA = {
  Google_Protobuf_Timestamp: {
    kind: "message",
    fields: [
      { number: 1, proto: "seconds", json: "seconds", repeated: false, type: "int64" },
      { number: 2, proto: "nanos", json: "nanos", repeated: false, type: "int32" },
    ],
  },
};

// Encoder: canonical JSON (proto3 JSON camelCase names, ISO timestamps,
// numeric-or-string int64) -> Buffer.
export function encodeProto(schema, messageName, value) {
  const def = lookup(schema, messageName);
  if (!def || def.kind !== "message") throw new Error(`schema has no message ${messageName}`);
  const byJson = new Map(def.fields.map((f) => [f.json ? f.json : f.proto, f]));
  const byProto = new Map(def.fields.map((f) => [f.proto, f]));
  const output = [];
  const entries = value && typeof value === "object" ? Object.entries(value) : [];
  for (const [key, rawValue] of entries) {
    if (rawValue === undefined || rawValue === null) continue;
    const field = byJson.get(key) || byProto.get(key) || null;
    if (!field) continue;
    if (field.repeated && !Array.isArray(rawValue)) {
      emit(schema, field, rawValue, output);
      continue;
    }
    const items = field.repeated ? rawValue : [rawValue];
    for (const item of items) emit(schema, field, item, output);
  }
  return Buffer.from(output);
}

function emit(schema, field, item, output) {
  const wireType = wireTypeFor(schema, field, field.type);
  encodeVarint(BigInt.asUintN(64, (BigInt(field.number) << 3n) | BigInt(wireType)), output);
  if (wireType === 0) {
    if (field.type === "bool") {
      encodeVarint(item ? 1n : 0n, output);
      return;
    }
    if (field.type === "sint32" || field.type === "sint64") {
      encodeVarint(BigInt.asUintN(64, zigzagEncode(item)), output);
      return;
    }
    const numeric = enumNumber(schema, field, item);
    encodeVarint(BigInt.asUintN(64, BigInt(numeric)), output);
    return;
  }
  if (wireType === 2) {
    let bytes;
    if (field.type === "string") bytes = Buffer.from(String(item), "utf8");
    else if (field.type === "bytes") bytes = Buffer.from(String(item), "base64");
    else if (field.type === "Google_Protobuf_Timestamp") bytes = encodeTimestampBuffer(item);
    else bytes = encodeProto(schema, field.type, item ?? {});
    encodeVarint(bytes.length, output);
    for (const byte of bytes) output.push(byte);
    return;
  }
  if (wireType === 1) {
    const buffer = Buffer.alloc(8);
    if (field.type === "double") buffer.writeDoubleLE(Number(item), 0);
    else buffer.writeBigUInt64LE(BigInt.asUintN(64, BigInt(Math.trunc(Number(item)))), 0);
    for (const byte of buffer) output.push(byte);
    return;
  }
  if (wireType === 5) {
    const buffer = Buffer.alloc(4);
    buffer.writeFloatLE(Number(item), 0);
    for (const byte of buffer) output.push(byte);
    return;
  }
  throw new Error(`unsupported wire type ${wireType}`);
}

function enumNumber(schema, field, item) {
  if (typeof item === "boolean") return item ? 1 : 0;
  if (typeof item === "number") return item;
  if (typeof item === "string") {
    const def = lookup(schema, field.type);
    const match = def?.kind === "enum"
      ? def.fields.find((candidate) => candidate.proto === item || candidate.json === item)
      : null;
    if (match) return match.number;
    const numeric = Number(item);
    if (Number.isFinite(numeric)) return numeric;
  }
  if (item && typeof item === "object") {
    // Some numeric enums can be wrapped objects; take their first numeric field.
    const numeric = Object.values(item).find((entry) => typeof entry === "number");
    if (typeof numeric === "number") return numeric;
  }
  return 0;
}

// Decoder: Buffer -> canonical JSON (json names camelCase when declared,
// proto name otherwise, ISO strings for Timestamps, base64 for bytes,
// numbers for numerics, string for 64-bit-wide values to avoid precision
// loss where the caller cares). Unknown field numbers are preserved as
// "<number>" keys with their wire value so nothing is silently dropped.
export function decodeProto(schema, messageName, buffer) {
  const def = lookup(schema, messageName);
  if (!def || def.kind !== "message") throw new Error(`schema has no message ${messageName}`);
  const byNumber = new Map(def.fields.map((f) => [f.number, f]));
  const result = {};
  let offset = 0;
  while (offset < buffer.length) {
    const [tag, tagEnd] = readVarint(buffer, offset);
    offset = tagEnd;
    const fieldNumber = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    const field = byNumber.get(fieldNumber) || null;
    const name = field ? (field.json || field.proto) : String(fieldNumber);
    if (wire === 0) {
      const [raw, next] = readVarint(buffer, offset);
      offset = next;
      let value;
      if (field?.type === "bool") value = raw !== 0n;
      else if (field?.type === "sint32" || field?.type === "sint64") value = zigzagDecode(raw);
      else if (field?.type === "int32") value = Number(BigInt.asIntN(32, raw));
      else if (field?.type === "int64") value = Number(BigInt.asIntN(64, raw));
      else if (schema[field?.type]?.kind === "enum") value = Number(raw);
      else value = Number(raw);
      assign(schema, result, field, name, value);
    } else if (wire === 1) {
      const bytes = buffer.subarray(offset, offset + 8);
      offset += 8;
      let value;
      if (field?.type === "double") value = bytes.readDoubleLE(0);
      else if (field?.type === "fixed64" || field?.type === "uint64") value = BigInt.asUintN(64, bytes.readBigUInt64LE(0));
      else if (field?.type === "int64" || field?.type === "sfixed64") value = BigInt.asIntN(64, bytes.readBigInt64LE(0));
      else value = bytes.toString("base64");
      assign(schema, result, field, name, value);
    } else if (wire === 2) {
      const [rawLength, next] = readVarint(buffer, offset);
      const length = Number(rawLength);
      const payload = buffer.subarray(next, next + length);
      offset = next + length;
      let value;
      if (field?.type === "string") value = payload.toString("utf8");
      else if (field?.type === "bytes") value = payload.toString("base64");
      else if (field?.type === "Google_Protobuf_Timestamp") {
        const nested = decodeProto(schema, field.type, payload);
        const ms = Number(nested.seconds || 0) * 1000 + Math.floor(Number(nested.nanos || 0) / 1e6);
        value = new Date(ms).toISOString();
      } else if (field?.type === "Google_Protobuf_Any" || field?.type === "Google_Protobuf_Struct") {
        value = payload.toString("base64");
      } else if (field) {
        value = decodeProto(schema, field.type, payload);
      } else {
        value = payload.toString("base64");
      }
      assign(schema, result, field, name, value);
    } else if (wire === 5) {
      const bytes = buffer.subarray(offset, offset + 4);
      offset += 4;
      const value = bytes.readFloatLE(0);
      assign(schema, result, field, name, value);
    } else {
      throw new Error(`unsupported wire type ${wire} in ${messageName}`);
    }
  }
  return result;
}

function assign(schema, result, field, name, value) {
  if (field?.repeated) {
    if (!Array.isArray(result[name])) result[name] = [];
    result[name].push(value);
  } else {
    result[name] = value;
  }
}

// Connect framing: 1 byte flags + 4 byte big-endian payload length.
export function decodeConnectFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 5 > buffer.length) throw new Error("truncated connect frame header");
    const flags = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    const payload = buffer.subarray(offset + 5, offset + 5 + length);
    if (payload.length !== length) throw new Error("truncated connect frame payload");
    frames.push({ flags, payload });
    offset += 5 + length;
  }
  return frames;
}

export function encodeFrames(frames) {
  const chunks = [];
  for (const frame of frames) {
    const header = Buffer.alloc(5);
    header.writeUInt8(frame.flags ?? 0, 0);
    header.writeUInt32BE(frame.payload.length, 1);
    chunks.push(header, frame.payload);
  }
  return Buffer.concat(chunks);
}

export const CONNECT_END_STREAM_FLAGS = 0x02;
export const CONNECT_MESSAGE_FLAGS = 0x00;
