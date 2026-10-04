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

// `ChannelMessage` (field descriptor 104c762ac) declares NINE non-Optional
// fields; every other key on it is Optional. A synthesized `Codable` decode
// throws `keyNotFound` for an absent non-Optional key, and the app reports that
// as `ClaudeApiServices.ModelDecodingError` — so a frame that carries the five
// "interesting" keys and drops the four incidental-looking ones fails on the
// device while looking complete in a hand-written mock like this one. The list
// is transcribed from the binary, not from what the facade happens to send.
const CHANNEL_MESSAGE_REQUIRED = [
  "id", "in_timeline", "server_notice", "attachments", "participant_account_ids",
  "bound_sessions", "reactions", "attached_outputs", "links",
];

export function decodeChannelMessage(message) {
  assert.ok(message && typeof message === "object" && !Array.isArray(message), "ChannelMessage is an object");
  for (const key of CHANNEL_MESSAGE_REQUIRED) {
    assert.ok(key in message, `ChannelMessage.${key} is non-Optional and must be on the wire`);
  }
  assert.equal(typeof message.id, "string", "ChannelMessage.id is a non-empty string");
  assert.ok(message.id.length);
  assert.equal(typeof message.in_timeline, "boolean", "ChannelMessage.in_timeline is Bool");
  assert.equal(typeof message.server_notice, "boolean", "ChannelMessage.server_notice is Bool");
  for (const key of ["attachments", "participant_account_ids", "bound_sessions", "reactions", "attached_outputs", "links"]) {
    assert.ok(Array.isArray(message[key]), `ChannelMessage.${key} is an array`);
  }
  assert.ok(message.body == null || typeof message.body === "string");
  return message;
}

// The channel stream is discriminated by the SSE event NAME, and the frame's
// `data:` is decoded directly as that case's payload type (the dispatcher maps
// the name to the case and hands `data` to it). Only the names in the app's
// table mean anything; anything else is ignored, which is why an unknown event
// name is safe and a known one with the wrong payload is not.
const CHANNEL_STREAM_EVENTS = new Set([
  "channel_message_updated", "channel_message_reactions", "session_activity",
  "thread_session_bound", "session_requires_action",
]);

export function decodeChannelStreamFrame(event, data) {
  if (!CHANNEL_STREAM_EVENTS.has(event)) return null; // ignored, not a failure
  if (event === "channel_message_updated") return decodeChannelMessage(data);
  return data;
}
