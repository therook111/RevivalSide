const { readSignedVarInt } = require("../modules/packet-codec");

const NSI_GAME = 3;
const NSI_OPERATION = 9;

module.exports = {
  packetId: 606,
  name: "UI_SCEN_CHANGED_REQ",
  handle(ctx, socket, packet) {
    const sceneId = readSceneId(ctx, packet);
    if (ctx.config.VERBOSE_CAPTURE_LOGS) {
      console.log(`[capture-game] UI_SCEN_CHANGED_REQ observed scene=${sceneId}; official flow sends no direct ACK`);
    }
    const replay = socket.session && socket.session.gameReplay;
    const previousSceneId = replay ? Number(replay.lastSceneId || 0) : 0;
    if (replay) replay.lastSceneId = sceneId;
    if (
      ctx.config.DYNAMIC_BATTLE_MANAGER &&
      replay &&
      replay.dynamicGame &&
      sceneId !== NSI_GAME &&
      !replay.dynamicBattleResultSent &&
      (previousSceneId === NSI_GAME ||
        replay.dynamicBattleTimer ||
        (replay.loadCompleteReceived && replay.dynamicGame.initialUnitsSent))
    ) {
      if (typeof ctx.abandonDynamicBattle === "function") {
        ctx.abandonDynamicBattle(socket, `scene-${previousSceneId}-to-${sceneId}`);
      } else if (typeof ctx.stopGameSyncTimers === "function") {
        ctx.stopGameSyncTimers(socket);
        replay.dynamicBattleResultSent = true;
      }
    }
    if (sceneId === NSI_OPERATION && typeof ctx.repairPostTutorialGuideMissionsForSocket === "function") {
      ctx.repairPostTutorialGuideMissionsForSocket(socket, {
        label: "operation-post-tutorial-guide-mission-complete",
        notify: true,
      });
    }
    if (
      ctx.config.DYNAMIC_BATTLE_MANAGER &&
      replay &&
      replay.pendingGameStartBootstrap &&
      replay.loadCompleteReceived &&
      replay.dynamicGame
    ) {
      if (sceneId !== NSI_GAME) {
        console.log(`[battle-manager:scene-ready] pending bootstrap; scene=${sceneId} not NSI_GAME`);
        return true;
      }
      ctx.sendPendingGameStartSync(socket, "scene-ready");
    }
    return true;
  },
};

function readSceneId(ctx, packet) {
  try {
    const payload = packet && packet.payload ? ctx.decryptCopy(packet.payload) : Buffer.alloc(0);
    if (payload.length === 0) return 0;
    return readSignedVarInt(payload, 0).value;
  } catch (_) {
    return 0;
  }
}
