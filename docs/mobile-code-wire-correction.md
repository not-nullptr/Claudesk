# Code transcript loading: wire contract correction

Cloned revision: `318eab6`. Analyzed app: the supplied decrypted Claude iOS
`1.260925.19` IPA. This diagnosis comes from the binary's field-type references,
Decodable witnesses, and arm64 decoder instructions, not just nearby strings.
The list request and transcript requests use different DTOs, so a working Code
session list does not establish that the transcript responses are valid.

## What was wrong

| Layer | Claudesk at `318eab6` | What this IPA actually consumes |
| --- | --- | --- |
| HTTP history | `data` and `rows` containing `{sequence_num, message: {user/assistant: ...}}` | `ListClientEventsResponse`: `{data: [SessionEventEnvelope], next_cursor}` |
| SSE transcript | `event: client_event` with `{"client_event":{"sdk_message":...}}` | `event: client_event` with a **SessionEventEnvelope directly in `data:`** |
| SDK payload | Synthesized enum wrappers such as `{user: ...}`; older code also invented `assistant_text`/`tool_use` events | Flat stream-json `{type: "user" / "assistant" / "result" / ..., uuid, message, ...}` |
| Sequence | Numeric history indexes starting at `0`; SSE had no envelope sequence | A decimal **string**, parsed as a strictly positive integer (`"1"`, `"2"`, ...); `0` is only a resume floor |
| Live numbering | Separate unseeded counter | Seeded from the same history; a UUID keeps its number across replay and multiple listeners |

The earlier notes confused in-memory app models with network DTOs. In
particular, `ClientEventsPage.Row.message` really is a `SdkMessage`, but that
row is **built by the app after decoding the wire envelope**. It is not the
element of `ListClientEventsResponse.data`. Likewise, `SessionSseFrame` and
`StdoutMessage.sdkMessage` describe internal enum cases; they are not JSON
wrapper keys. The actual `SdkMessage` and `StdoutMessage` CodingKeys each
contain only `type`.

These errors explain both symptoms: a history decode can fail, or optional
fields can decode absent and then be discarded by the event contract/parser.
The live stream cannot recover the missing history because its own envelope
is malformed. An HTTP 200 alone does not establish successful app decoding.

## Correct wire example

HTTP `GET /v1/code/sessions/{id}/events?sort_order=desc&limit=200`:

```json
{
  "data": [{
    "event_id": "11111111-1111-4111-8111-111111111111",
    "sequence_num": "1",
    "event_type": "user",
    "source": "human",
    "payload": {
      "type": "user",
      "uuid": "11111111-1111-4111-8111-111111111111",
      "message": {"role": "user", "content": "hello"}
    },
    "created_at": "2026-10-03T10:00:00.000Z"
  }],
  "next_cursor": null
}
```

For SSE, send `event: client_event` and put that **same single envelope** in
`data:`. Do not add `client_event`, `sdk_message`, `user`, or `assistant`
wrapper objects. Assistant text, thinking, tool use, and tool results remain
inside the original SDK message's content blocks. Preserve snake_case fields
such as `parent_tool_use_id`, `duration_ms`, and `is_error` as well as Desktop's
camelCase equivalents; the old camelCase-only allowlists silently dropped them.

## Binary evidence

All addresses below are unslid virtual addresses, with image base `0x100000000`.
Executable SHA-256:
`e24059999ebaef751ff469f6ef023885a44a08820c3b4007da4109bb3e65023a`.

| Evidence | Address and observation |
| --- | --- |
| HTTP wire element type | `ListClientEventsResponse` descriptor `0x104ae9214`, field descriptor `0x104c7eed8`. Its `data` mangled type at `0x1045cc6de` is `Say<symbolic reference>G`; the reference resolves to **`SessionEventEnvelope` at `0x104ae90e4`**, not `Row`. |
| Internal row | `ClientEventsPage.Row` descriptor `0x104ae917c` has `sequenceNum` and `message: SdkMessage` (`0x104ae7088`). This is distinct from the wire element above. |
| Envelope field types | Field descriptor `0x104c7ecdc`: `eventId` is an optional tagged string; `sequenceNum`, `eventType`, `source`, and `createdAt` are `String?`; `payload` is `JSONObject?`. `sequenceNum`'s mangling is `SSSg`. |
| SSE envelope decode | Dispatcher `0x101eb7af4` selects `client_event`; at `0x101eb7b84` it obtains the Decodable witness for `SessionEventEnvelope` via `0x101eb9040`. It passes metadata `0x105305810` (whose descriptor pointer is `0x104ae90e4`) to `JSONDecoder.decode` through `0x101edb860`. It does not decode a synthesized `SessionSseFrame` JSON object. |
| Required stream identifiers | `0x101eb83e8` parses `sequenceNum` and checks that `eventId` is present; failure creates `SessionStreamContractViolationError`. |
| Sequence parsing | `0x101eb51c0` parses an optional decimal string. Instructions at `0x101eb5390`–`0x101eb53a4` accept only successful results **greater than zero**. |
| Payload reconstruction | `0x101eb84f8` starts from the payload dictionary, sets `type` from `eventType` when supplied, supplies `uuid` from `eventId` when missing, adds `created_at`, and decodes **StdoutMessage**. |
| HTTP uses that same reconstruction | `0x101efb410` iterates 88-byte envelopes, parses the sequence at `0x101efb5c4`, checks the event ID, and calls `0x101eb84f8` at `0x101efb6ec` before building internal rows. |
| SDK discriminators | Actual CodingKeys descriptors: `SdkMessage` `0x104ae71b8`; `StdoutMessage` `0x104ae7194`. **Both have just `type`.** Their custom decoders are `0x101e0bfac` and `0x101e0e7f4`; the latter calls the former on its SDK branch at `0x101e0e99c`. |

Reproduce the metadata checks without third-party libraries:

```sh
python3 scripts/inspect-mobile-code-ipa.py /path/to/Claude.ipa
```

The script checks the executable hash and reads Mach-O/Swift metadata directly.
It deliberately skips complete symbolic references when parsing type names;
these references can contain NUL bytes, so treating them as C strings loses the
array element type and optional suffix. Decoder-instruction findings above
were separately inspected with Capstone 5.0.9 and LIEF 1.0.0.

## Patch and verification

- `mobile/code-transcript.mjs`: one shared wire envelope, flat SDK payloads,
  positive string sequences, numeric cursor comparisons, and UUID replay handling.
- `mobile/code-engine.mjs`: return `data: [SessionEventEnvelope]` and seed live
  numbering from loaded history.
- `mobile/code-events.mjs`: attach the stable sequence to every live envelope.
- `mobile/server.mjs`: replay those envelopes, resume strictly after the last
  sequence, and subscribe before reading the snapshot so live events cannot fall
  between the read and subscription. Transcript traces now log metadata.
- `scripts/lib/code-wire-contract.mjs`: an independent **partial** decoder model
  based on the evidence above, including rejection of the old wire shapes.

Validation passed:

```sh
node scripts/code-events-smoke.mjs
node scripts/mobile-api-smoke.mjs
```

The first exercises recorded Desktop message content, tools/thinking, both
field casings, sequence rejection, pagination across 9/10, replay, and history
seeding. The second exercises the real local HTTP/SSE facade against the fake
Desktop bridge: history, older pages, resumed streams, history/stream equality,
and concurrent GET/POST live listeners continuing after existing history.

This is a statically verified protocol correction with offline integration
coverage. It has **not** been run on a physical iPhone or against the user's
live Desktop deployment. The `watch` list protocol and broader Code feature
parity are separate from the transcript contract established here.
