const { ensureLoginRewardPosts } = require("../modules/admin");
const { buildAttendanceNotifyPayload, ensureAttendanceRewardPosts } = require("../modules/attendance");

module.exports = {
  packetId: 204,
  name: "JOIN_LOBBY_REQ",
  handle(ctx, socket, packet) {
    const joinReq = ctx.decodeJoinLobbyReq(packet.payload);
    const user = ctx.findUserByAccessToken(joinReq.accessToken) || socket.session.user || ctx.createEphemeralUser();
    socket.session.user = user;
    if (ctx.config.USE_LOCAL_USER_DB && user.userUid) {
      user.lastJoinAt = new Date().toISOString();
      const rewardPosts = ensureLoginRewardPosts(user);
      const attendancePosts = ensureAttendanceRewardPosts(user);
      if (rewardPosts > 0 || attendancePosts > 0) {
        console.log(
          `[user-db] queued inbox rewards uid=${user.userUid} loginPosts=${rewardPosts} attendancePosts=${attendancePosts}`
        );
      }
      ctx.saveUserDb();
    }

    const replay = socket.session.gameReplay;
    replay.inGameFlow = true;

    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      if (ctx.shouldUseLocalJoinLobbyAck(user)) {
        if (!replay.bootLobbyTemplateSent) {
          sendJoinLobbyBootTemplates(ctx, socket, replay, user);
        }
        const joinLobbyPayload = ctx.buildJoinLobbyAckPayload(user);
        if (ctx.config.USE_LOCAL_USER_DB && user.userUid) ctx.saveUserDb();
        ctx.sendServerGamePacket(
          socket,
          ctx.constants.JOIN_LOBBY_ACK,
          joinLobbyPayload,
          "join-lobby-local-progress"
        );
        if (typeof ctx.repairPostTutorialGuideMissionsForSocket === "function") {
          ctx.repairPostTutorialGuideMissionsForSocket(socket, {
            label: "join-lobby-post-tutorial-guide-mission-complete",
            notify: true,
          });
        }
        ctx.sendStaminaChargeNotifications(socket, "join-lobby-charge-item", { includeUnchanged: true, itemIds: [2, 13] });
        replay.localJoinLobbyAckSent = true;
        sendPostLobbyBootTemplates(ctx, socket, replay);
        ctx.skipCapturedGameThroughPacketId(socket, ctx.constants.JOIN_LOBBY_ACK);
      } else {
        if (ctx.hasTutorialProgress(user)) {
          console.log("[JOIN_LOBBY_REQ] using captured lobby ACK; local account overlay disabled");
        }
        ctx.sendCapturedGameThroughPacketId(socket, ctx.constants.JOIN_LOBBY_ACK, "join-lobby");
        if (typeof ctx.repairPostTutorialGuideMissionsForSocket === "function") {
          ctx.repairPostTutorialGuideMissionsForSocket(socket, {
            label: "join-lobby-post-tutorial-guide-mission-complete",
            notify: true,
          });
        }
      }
      return true;
    }

    if (!replay.bootLobbyTemplateSent) {
      sendJoinLobbyBootTemplates(ctx, socket, replay, user);
    }
    const joinLobbyPayload = ctx.buildJoinLobbyAckPayload(user);
    if (ctx.config.USE_LOCAL_USER_DB && user.userUid) ctx.saveUserDb();
    ctx.sendGameResponse(
      socket,
      packet,
      ctx.constants.JOIN_LOBBY_ACK,
      joinLobbyPayload,
      "join-lobby-local-progress"
    );
    if (typeof ctx.repairPostTutorialGuideMissionsForSocket === "function") {
      ctx.repairPostTutorialGuideMissionsForSocket(socket, {
        label: "join-lobby-post-tutorial-guide-mission-complete",
        notify: true,
      });
    }
    replay.nextServerSequence = Math.max(Number(replay.nextServerSequence || 1), Number(packet.sequence || 0) + 1);
    ctx.sendStaminaChargeNotifications(socket, "join-lobby-charge-item", { includeUnchanged: true, itemIds: [2, 13] });
    replay.localJoinLobbyAckSent = true;
    sendPostLobbyBootTemplates(ctx, socket, replay);
    return true;
  },
};

function sendJoinLobbyBootTemplates(ctx, socket, replay, user) {
  ctx.sendCapturedGameTemplateRange(socket, 1, 1, "join-lobby-boot");
  ctx.sendServerGamePacket(
    socket,
    1644,
    Buffer.concat([ctx.writeSignedVarInt(0), ctx.writeSignedVarInt(0)]),
    "join-lobby-boot-company-buff"
  );
  ctx.sendCapturedGameTemplateRange(socket, 3, 5, "join-lobby-boot");
  const attendancePayload = buildAttendanceNotifyPayload(user, { consumePrompt: true });
  if (attendancePayload) {
    ctx.sendServerGamePacket(socket, 1640, attendancePayload, "attendance-not");
  }
  ctx.sendCapturedGameTemplateRange(socket, 7, 7, "join-lobby-boot");
  replay.bootLobbyTemplateSent = true;
}

function sendPostLobbyBootTemplates(ctx, socket, replay) {
  if (replay.bootPostListTemplateSent) return;
  replay.bootPostListTemplateSent = true;
}
