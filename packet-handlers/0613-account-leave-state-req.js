module.exports = {
  packetId: 613,
  name: "ACCOUNT_LEAVE_STATE_REQ",
  handle(ctx, socket, packet) {
    let leave = false;
    try {
      const payload = ctx.decryptCopy(packet.payload);
      leave = payload.length > 0 && payload.readUInt8(0) !== 0;
    } catch (err) {
      console.log(`[ACCOUNT_LEAVE_STATE_REQ] decode failed: ${err.message}`);
    }

    console.log(`[ACCOUNT_LEAVE_STATE_REQ] leave=${leave ? 1 : 0}`);
    const ackPayload = Buffer.concat([
      ctx.writeSignedVarInt(0),
      Buffer.from([leave ? 1 : 0]),
    ]);
    ctx.sendGameResponse(socket, packet, 614, ackPayload, "account-leave-state");
    if (leave) {
      const replay = socket.session && socket.session.gameReplay;
      if (replay && replay.dynamicGame && !replay.dynamicBattleResultSent) {
        if (typeof ctx.abandonDynamicBattle === "function") {
          ctx.abandonDynamicBattle(socket, "account-leave-state");
        } else if (typeof ctx.stopGameSyncTimers === "function") {
          ctx.stopGameSyncTimers(socket);
          replay.dynamicBattleResultSent = true;
        }
      }
    }
    return true;
  },
};
