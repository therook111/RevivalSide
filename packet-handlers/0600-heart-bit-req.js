module.exports = {
  packetId: 600,
  name: "HEART_BIT_REQ",
  handle(ctx, socket, packet) {
    const payload = ctx.decryptCopy(packet.payload);
    const time = ctx.safeReadSignedVarLong(payload, 0).value;
    console.log(`[HEART_BIT] reqTime=${time}`);

    const replay = socket.session.gameReplay;
    replay.heartbeatCount += 1;
    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      if (!replay.loadCompleteReceived) {
        ctx.sendServerGamePacket(socket, ctx.constants.HEART_BIT_ACK, ctx.writeSignedVarLong(time), "heart-bit");
        ctx.sendStaminaChargeNotifications(socket, "heart-bit-charge-item");
        console.log("[capture-game] heartbeat before GAME_LOAD_COMPLETE_REQ; deferring combat sync until load complete");
        return true;
      }
      if (ctx.config.DYNAMIC_BATTLE_MANAGER && replay.battleSim) {
        ctx.sendServerGamePacket(socket, ctx.constants.HEART_BIT_ACK, ctx.writeSignedVarLong(time), "heart-bit");
        return true;
      }
      if (ctx.config.DYNAMIC_BATTLE_MANAGER && replay.dynamicGame) {
        replay.syntheticGameTime = Math.max(4, Number(replay.syntheticGameTime || 4) + 0.5);
        ctx.sendServerGamePacket(socket, ctx.constants.HEART_BIT_ACK, ctx.writeSignedVarLong(time), "heart-bit");
        if (replay.pendingGameStartBootstrap) {
          ctx.sendPendingGameStartSync(socket, "heart-bit-fallback");
          return true;
        }
        if (replay.dynamicBattleResultSent) {
          return true;
        }
        if (replay.dynamicBattleTimer) {
          return true;
        }
        const packets =
          replay.dynamicGame && !replay.dynamicGame.initialUnitsSent
            ? ctx.ensureGameStartPackets(ctx.buildInitialBattlePackets(replay), replay, socket)
            : ctx.buildGameSyncPackets({
                battleState: replay.battleState,
                dynamicGame: replay.dynamicGame,
                delta:
                  Number(
                    replay.dynamicGame && replay.dynamicGame.managedCombat
                      ? ctx.config.MANAGED_HOST_TICK_INTERVAL_MS || 33
                      : ctx.config.DYNAMIC_BATTLE_SYNC_INTERVAL_MS || 33
                  ) / 1000,
                gameTime: replay.syntheticGameTime,
                absoluteGameTime: replay.syntheticGameTime,
                gameStates: replay.heartbeatCount === 1 ? [{ state: 3, winTeam: 0, waveId: 1 }] : [],
              });
        ctx.sendManagedOrImmediatePackets(socket, packets);
        ctx.startDynamicBattleManager(socket, "heart-bit");
        return true;
      }
      if (ctx.config.DYNAMIC_BATTLE_MANAGER) {
        ctx.sendServerGamePacket(socket, ctx.constants.HEART_BIT_ACK, ctx.writeSignedVarLong(time), "heart-bit");
        console.log("[combat-host] heartbeat has no dynamic battle state; captured heartbeat replay disabled");
        return true;
      }
      ctx.sendCapturedHeartbeatReply(socket, time, "heart-bit");
      if (replay.nextServerIndex > ctx.capturedGameFlow.server.length) {
        if (!replay.officialCaptureExhaustedLogged) {
          console.log(
            `[official-missing] captured game flow exhausted after server index=${ctx.capturedGameFlow.server.length}; heartbeat ACK remains dynamic only`
          );
          replay.officialCaptureExhaustedLogged = true;
        }
      }
      return true;
    }
    if (ctx.config.DYNAMIC_BATTLE_MANAGER && replay.dynamicGame) {
      ctx.sendServerGamePacket(socket, ctx.constants.HEART_BIT_ACK, ctx.writeSignedVarLong(time), "heart-bit");
      if (!replay.loadCompleteReceived) {
        console.log("[capture-game] heartbeat before GAME_LOAD_COMPLETE_REQ; deferring combat sync until load complete");
        return true;
      }
      if (replay.pendingGameStartBootstrap) {
        ctx.sendPendingGameStartSync(socket, "heart-bit-fallback");
        return true;
      }
      if (!replay.dynamicBattleResultSent && !replay.dynamicBattleTimer) {
        ctx.startDynamicBattleManager(socket, "heart-bit");
      }
      return true;
    }
    ctx.sendGameResponse(socket, packet, ctx.constants.HEART_BIT_ACK, ctx.writeSignedVarLong(time), "heart-bit");
    if (typeof ctx.sendStaminaChargeNotifications === "function") {
      replay.nextServerSequence = Math.max(Number(replay.nextServerSequence || 1), Number(packet.sequence || 0) + 1);
      ctx.sendStaminaChargeNotifications(socket, "heart-bit-charge-item");
    }
    return true;
  },
};
