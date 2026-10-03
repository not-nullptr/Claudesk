// Independent, deliberately partial model of the IPA's envelope -> SDK decode.
// No production translator imports. Evidence: docs/mobile-code-wire-correction.md.
// This checks the transport contract; it does not replace an iOS device test.
import assert from "node:assert/strict";

export function decodeClientEvent(event) {
  assert.ok(event && typeof event === "object", "SessionEventEnvelope is an object");
  assert.equal(typeof event.event_id, "string", "event_id is required by the stream contract");
  assert.ok(event.event_id.length);
  assert.equal(typeof event.sequence_num, "string", "sequence_num decodes as String?");
  assert.match(event.sequence_num, /^\d+$/);
  assert.ok(BigInt(event.sequence_num) > 0n, "the app rejects sequence zero");
  assert.ok(event.payload && !Array.isArray(event.payload) && typeof event.payload === "object", "payload is a JSONObject");
  // 0x101eb84f8 overlays event_type, supplies uuid from event_id if absent,
  // and supplies created_at before decoding StdoutMessage -> SdkMessage.
  const message = { ...event.payload, type: event.event_type ?? event.payload.type,
    uuid: event.payload.uuid ?? event.event_id };
  if (event.created_at != null) message.created_at = event.created_at;
  assert.equal(typeof message.type, "string", "SDK messages have a flat type discriminator");
  if (message.type === "user") {
    assert.equal(message.message?.role, "user");
    assert.ok(typeof message.message.content === "string" || Array.isArray(message.message.content));
  } else if (message.type === "assistant") {
    assert.equal(message.message?.role, "assistant");
    assert.ok(Array.isArray(message.message.content));
  }
  return { sequence: BigInt(event.sequence_num), message };
}

export function decodeClientEventsResponse(response) {
  assert.ok(Array.isArray(response.data), "ListClientEventsResponse.data is an array of envelopes");
  assert.ok(response.next_cursor == null || typeof response.next_cursor === "string");
  return response.data.map(decodeClientEvent);
}
