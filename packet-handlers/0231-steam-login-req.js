const { ensureLoginRewardPosts } = require("../modules/admin");
const { ensureAttendanceRewardPosts } = require("../modules/attendance");
const { applyLocalAccountCleanup } = require("../modules/local-cleanup");

module.exports = {
  packetId: 231,
  name: "STEAM_LOGIN_REQ",
  handle(ctx, socket, packet) {
    const loginReq = ctx.decodeSteamLoginReq(packet.payload);
    socket.session.steamLogin = loginReq;

    if (ctx.config.USE_LOCAL_USER_DB) {
      const user = ctx.getOrCreateUserForSteam(loginReq);
      ctx.issueUserTokens(user, loginReq.accessToken);
      socket.session.user = user;
      ctx.setLastEffectiveAccessToken(user.accessToken || "");
      ctx.prepareTutorialLogin(user);
      ctx.recordMissionLogin(user, { now: ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : undefined });
      const cleanup = applyLocalAccountCleanup(user, ctx.config);
      const rewardPosts = ensureLoginRewardPosts(user);
      const attendancePosts = ensureAttendanceRewardPosts(user);
      ctx.saveUserDb();
      if (cleanup.changed) {
        console.log(
          `[user-db] cleanup uid=${user.userUid} missionStatus=${cleanup.missionStatus || 0} unitsLevel1=${cleanup.unitsLevel1} gearUnenhanced=${cleanup.gearUnenhanced} shipsLevel1=${cleanup.shipsLevel1} operatorsLevel1=${cleanup.operatorsLevel1}`
        );
      }
      console.log(
        `[user-db] login uid=${user.userUid} friendCode=${user.friendCode} nickname=${JSON.stringify(user.nickname)} loginKey=${JSON.stringify(user.steamLoginKey || user.steamAccountId || "")} tokenLen=${(user.accessToken || "").length} inboxRewardPosts=${rewardPosts + attendancePosts}`
      );
    }

    ctx.sendResponse(socket, packet.sequence, ctx.constants.LOGIN_ACK, () => {
      const captured = ctx.capturedTcpResponses.get(ctx.constants.LOGIN_ACK);
      if (ctx.config.REPLAY_CAPTURED_LOGIN_ACK && captured) {
        return ctx.buildCapturedLoginAck(packet.sequence, socket.session.user);
      }
      if (captured) {
        console.log(`[official-compare] packetId=${ctx.constants.LOGIN_ACK} using local payload instead of captured official payloadSize=${captured.payload.length}`);
      }
      return ctx.buildLoginAck(packet.sequence, socket.session.user);
    });
    return true;
  },
};
