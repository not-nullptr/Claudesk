#!/usr/bin/env python3
"""Read the Code wire-type evidence from the supplied 1.260925.19 IPA.

Standard library only; accepts an IPA or its extracted arm64 Claude executable.
Does not execute or modify the application. Decoder VAs are documented separately.
"""
import argparse
import hashlib
import json
import struct
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("path", type=Path)
args = parser.parse_args()
if zipfile.is_zipfile(args.path):
    with zipfile.ZipFile(args.path) as archive:
        blob = archive.read("Payload/Claude.app/Claude")
else:
    blob = args.path.read_bytes()

digest = hashlib.sha256(blob).hexdigest()
expected_digest = "e24059999ebaef751ff469f6ef023885a44a08820c3b4007da4109bb3e65023a"
if digest != expected_digest:
    parser.error("This evidence check targets the supplied executable; SHA-256 differs: " + digest)
assert struct.unpack_from("<I", blob)[0] == 0xFEEDFACF, "expected little-endian Mach-O 64"
sections = []
offset = 32
for _ in range(struct.unpack_from("<I", blob, 16)[0]):
    command, size = struct.unpack_from("<II", blob, offset)
    if command == 0x19:  # LC_SEGMENT_64
        for index in range(struct.unpack_from("<I", blob, offset + 64)[0]):
            section = offset + 72 + index * 80
            name = blob[section:section + 16].split(b"\0")[0].decode()
            address, length, file_offset = struct.unpack_from("<QQI", blob, section + 32)
            sections.append((address, length, file_offset))
    offset += size


def file_offset(address):
    for base, length, start in sections:
        if base <= address < base + length:
            return start + address - base
    raise ValueError(f"unmapped address {address:#x}")


def u32(address):
    return struct.unpack_from("<I", blob, file_offset(address))[0]


def relative(address):
    return address + struct.unpack_from("<i", blob, file_offset(address))[0]


def string(address):
    start = file_offset(address)
    return blob[start:blob.index(b"\0", start)].decode()


def typename(descriptor):
    return string(relative(descriptor + 8))


def mangled(address):
    # Swift symbolic references contain NUL bytes: they are NOT C strings.
    # Skip the complete four-byte displacement when reading a symbolic ref.
    tokens = []
    text = bytearray()
    while True:
        byte = blob[file_offset(address)]
        if byte == 0:
            break
        if byte in (1, 2):
            if text:
                tokens.append(text.decode())
                text.clear()
            target = relative(address + 1)
            if byte == 2:
                pointer = struct.unpack_from("<Q", blob, file_offset(target))[0]
                # Chained rebases in this executable store image-relative targets.
                if pointer >> 63:
                    tokens.append({"imported_type": hex(pointer)})
                    address += 5
                    continue
                target = 0x100000000 + (pointer & 0xFFFFFFFF)
            tokens.append({"type": typename(target), "descriptor": hex(target)})
            address += 5
        else:
            text.append(byte)
            address += 1
    if text:
        tokens.append(text.decode())
    return tokens


def fields(descriptor):
    field_descriptor = relative(descriptor + 16)
    record_size = struct.unpack_from("<H", blob, file_offset(field_descriptor + 10))[0]
    result = {}
    for index in range(u32(field_descriptor + 12)):
        record = field_descriptor + 16 + index * record_size
        name = string(relative(record + 8))
        result[name] = mangled(relative(record + 4)) if u32(record + 4) else []
    return result


response = fields(0x104AE9214)
envelope = fields(0x104AE90E4)
row = fields(0x104AE917C)
sdk_keys = fields(0x104AE71B8)
stdout_keys = fields(0x104AE7194)
assert response["data"] == ["Say", {"type": "SessionEventEnvelope", "descriptor": "0x104ae90e4"}, "G"]
assert envelope["sequenceNum"] == ["SSSg"]  # String?
assert row["message"] == [{"type": "SdkMessage", "descriptor": "0x104ae7088"}]
assert list(sdk_keys) == ["type"]
assert list(stdout_keys) == ["type"]
print(json.dumps({
    "executable_sha256": digest,
    "ListClientEventsResponse": response,
    "SessionEventEnvelope": envelope,
    "ClientEventsPage.Row (internal)": row,
    "SdkMessage.CodingKeys": sdk_keys,
    "StdoutMessage.CodingKeys": stdout_keys,
    "result": "confirmed: envelope array, String? sequence, flat type-discriminated SDK messages",
}, indent=2))
