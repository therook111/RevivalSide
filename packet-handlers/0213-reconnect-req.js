module.exports = {
  packetId: 213,
  name: "RECONNECT_REQ",
  handle(ctx, socket, packet) {
    const payload = ctx.decryptCopy(packet.payload);
    const reconnectKey = ctx.safeReadString(payload, 0);
    console.log(`[RECONNECT_REQ] reconnectKey=${JSON.stringify(reconnectKey.value)} len=${reconnectKey.value.length}`);
    const user = ctx.findUserByReconnectKey(reconnectKey.value) || socket.session.user || ctx.createEphemeralUser();
    const abandoned =
      typeof ctx.abandonDynamicBattle === "function" ? ctx.abandonDynamicBattle(socket, "reconnect") : false;
    if (!abandoned && typeof ctx.stopGameSyncTimers === "function") {
      ctx.stopGameSyncTimers(socket);
    }
    socket.session.gameReplay = {
      ...socket.session.gameReplay,
      inGameFlow: false,
      loadCompleteReceived: false,
      nextServerIndex: 1,
      nextServerSequence: 1,
      officialCaptureExhaustedLogged: false,
      dynamicBattleResultSent: false,
      lastRespawnReq: null,
    };
    if (user) {
      socket.session.user = user;
      ctx.issueUserTokens(user, user.accessToken);
      ctx.saveUserDb();
      console.log(`[user-db] reconnect uid=${user.userUid} tokenLen=${(user.accessToken || "").length}`);
    }
    ctx.sendResponse(socket, packet.sequence, ctx.constants.RECONNECT_ACK, () =>
      ctx.buildCapturedReconnectAck(packet.sequence, user)
    );
    return true;
  },
};
