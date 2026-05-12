const {
  readString,
  writeSignedVarInt,
  writeString,
  writeNullObject,
} = require("../../packet-codec");

const CHANGE_NICKNAME_ACK = 212;
const TUTORIAL_NICKNAME_MISSION_ID = 999;

module.exports = {
  packetId: 211,
  name: "CHANGE_NICKNAME_REQ",
  handle(ctx, socket, packet) {
    const request = decodeNicknameReq(ctx, packet.payload);
    const user = socket.session.user || ctx.createEphemeralUser();
    socket.session.user = user;

    const nickname = normalizeNickname(request.nickname, user.nickname || "LocalAdmin");
    user.nickname = nickname;
    user.lastNicknameChangeAt = new Date().toISOString();
    markNicknameTutorialComplete(ctx, user);

    if (ctx.config.USE_LOCAL_USER_DB) ctx.saveUserDb();
    console.log(`[user-db] nickname uid=${user.userUid || "(ephemeral)"} nickname=${JSON.stringify(nickname)}`);

    ctx.sendGameResponse(socket, packet, CHANGE_NICKNAME_ACK, buildNicknameAckPayload(nickname), "change-nickname");
    return true;
  },
};

function decodeNicknameReq(ctx, encryptedPayload) {
  try {
    const payload = ctx.decryptCopy(encryptedPayload);
    return { nickname: readString(payload, 0).value };
  } catch (err) {
    console.log(`[CHANGE_NICKNAME_REQ] decode failed: ${err.message}`);
    return { nickname: "" };
  }
}

function normalizeNickname(nickname, fallback) {
  const text = String(nickname || "").trim();
  if (!text) return fallback || "LocalAdmin";
  return text.slice(0, 32);
}

function markNicknameTutorialComplete(ctx, user) {
  user.tutorial = user.tutorial && typeof user.tutorial === "object" ? user.tutorial : {};
  user.tutorial.nicknameChanged = true;
  user.tutorial.nicknameChangedAt = new Date().toISOString();
  user.completedMissions =
    user.completedMissions && typeof user.completedMissions === "object" ? user.completedMissions : {};
  user.completedMissions[String(TUTORIAL_NICKNAME_MISSION_ID)] = {
    tabId: 1,
    groupId: TUTORIAL_NICKNAME_MISSION_ID,
    missionID: TUTORIAL_NICKNAME_MISSION_ID,
    times: 1,
    lastUpdateDate: String(ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : "0"),
    isComplete: true,
    rewardReady: true,
    completedAt: user.tutorial.nicknameChangedAt,
  };
}

function buildNicknameAckPayload(nickname) {
  return Buffer.concat([
    writeSignedVarInt(0),
    writeString(nickname),
    writeNullObject(),
  ]);
}
