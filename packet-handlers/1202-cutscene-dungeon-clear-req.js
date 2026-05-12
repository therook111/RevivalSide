module.exports = {
  packetId: 1202,
  name: "CUTSCENE_DUNGEON_CLEAR_REQ",
  handle(ctx, socket, packet) {
    const dungeonId = ctx.resolveCutsceneClearDungeonId(socket, ctx.readCutsceneDungeonReq(packet.payload));
    ctx.recordPersistentCutsceneView(socket, dungeonId);
    ctx.recordGameplayUnlockClear(socket, dungeonId);
    ctx.recordTutorialCutsceneClear(socket, dungeonId);
    ctx.recordMainStoryDungeonClear(socket, dungeonId);
    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      ctx.sendServerGamePacket(
        socket,
        ctx.constants.CUTSCENE_DUNGEON_CLEAR_ACK,
        ctx.buildCutsceneDungeonClearAckPayload(dungeonId),
        `cutscene-clear dungeonID=${dungeonId}`
      );
      return true;
    }
    ctx.sendGameResponse(
      socket,
      packet,
      ctx.constants.CUTSCENE_DUNGEON_CLEAR_ACK,
      ctx.buildCutsceneDungeonClearAckPayload(dungeonId),
      `cutscene-clear dungeonID=${dungeonId}`
    );
    return true;
  },
};
