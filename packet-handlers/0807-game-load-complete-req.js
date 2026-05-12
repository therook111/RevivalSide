module.exports = {
  packetId: 807,
  name: "GAME_LOAD_COMPLETE_REQ",
  handle(ctx, socket) {
    socket.session.gameReplay.loadCompleteReceived = true;
    if (ctx.config.DYNAMIC_BATTLE_MANAGER && socket.session.gameReplay.dynamicGame) {
      const replay = socket.session.gameReplay;
      const packets = ctx.ensureGameStartPackets(ctx.buildInitialBattlePackets(replay), replay, socket);
      replay.pendingGameStartPackets = packets.filter(Boolean);
      socket.session.gameReplay.pendingGameStartBootstrap = true;
      ctx.sendPendingGameStartSync(socket, "load-complete");
      return true;
    }
    if (ctx.config.DYNAMIC_BATTLE_MANAGER) {
      console.log("[combat-host] GAME_LOAD_COMPLETE_REQ has no dynamic battle state; captured battle bootstrap replay disabled");
      return true;
    }
    if (!ctx.config.REPLAY_CAPTURED_GAME_FLOW || !ctx.capturedGameFlow) return false;
    ctx.sendCapturedGameUntilBeforePacketIds(socket, [ctx.constants.HEART_BIT_ACK], "game-load-complete");
    return true;
  },
};
