module.exports = {
  packetId: 216,
  name: "CONTENTS_VERSION_REQ",
  handle(ctx, socket, packet) {
    const official = ctx.capturedTcpProfiles.contentsVersionAck;
    const requiredTags = ctx.config.REQUIRED_CONTENTS_TAGS || [];
    const contentsTags = official ? mergeTags(official.contentsTag, requiredTags) : ctx.config.CONTENTS_TAGS;
    ctx.setLastAckContents(
      official ? official.contentsVersion : ctx.config.CONTENTS_VERSION,
      contentsTags
    );
    ctx.sendResponse(socket, packet.sequence, ctx.constants.CONTENTS_VERSION_ACK, () => {
      const captured = ctx.capturedTcpResponses.get(ctx.constants.CONTENTS_VERSION_ACK);
      if (ctx.config.REPLAY_CAPTURED_CONTENTS_VERSION && captured) {
        if (official && !hasAllTags(official.contentsTag, requiredTags)) {
          console.log("[capture-replay] CONTENTS_VERSION_ACK missing required local tags; using local fallback");
          return ctx.buildContentsVersionAck(packet.sequence);
        }
        console.log(
          `[capture-replay] packetId=${ctx.constants.CONTENTS_VERSION_ACK} compressed=${captured.compressed ? 1 : 0} payloadSize=${captured.payload.length}`
        );
        if (captured.raw && captured.sequence === packet.sequence) return captured.raw;
        return ctx.buildFramedPacket(packet.sequence, ctx.constants.CONTENTS_VERSION_ACK, captured.payload, captured.compressed);
      }
      return ctx.buildContentsVersionAck(packet.sequence);
    });
    return true;
  },
};

function hasAllTags(tags, requiredTags) {
  const set = new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag || "").toUpperCase()));
  return (Array.isArray(requiredTags) ? requiredTags : []).every((tag) => set.has(String(tag || "").toUpperCase()));
}

function mergeTags(...groups) {
  const seen = new Set();
  const tags = [];
  for (const group of groups) {
    for (const tag of Array.isArray(group) ? group : []) {
      const text = String(tag || "").trim();
      const key = text.toUpperCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      tags.push(text);
    }
  }
  return tags;
}
