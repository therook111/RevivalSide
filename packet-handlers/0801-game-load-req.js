const { getTutorialStageForRequest, isTutorialDungeonId, isTutorialStageId } = require("../stages/tutorialStage");
const { getMainStoryStageForRequest } = require("../stages/mainStoryStage");
const { buildPlayerDeckForGameLoad } = require("../modules/unit");
const { eventDeckHasFreeShipSlot, eventDeckHasGivenUnitSlots, getEventDeckPlayerUnitSlots } = require("../modules/game-data");

module.exports = {
  packetId: 801,
  name: "GAME_LOAD_REQ",
  handle(ctx, socket, packet) {
    ctx.logGameLoadReq(packet.payload);
    const req = ctx.decodeGameLoadReq(packet.payload);
    // Stage selection can arrive with a stale/captured dungeonID. Prefer the
    // selected stageID first so Act 2+ does not get pulled back into 1004.
    // Tutorial stages must come from tutorialStage.js, not the main-story catalog
    // wrapper, because that module carries the phase-specific tutorial runtime.
    const requestedStageId = Number((req && req.stageID) || 0);
    const requestedDungeonId = Number((req && req.dungeonID) || 0);
    const explicitTutorial = isTutorialStageId(requestedStageId) || isTutorialDungeonId(requestedDungeonId);
    const stage = (explicitTutorial
      ? getTutorialStageForRequest({ stageID: requestedStageId, dungeonID: requestedDungeonId })
      : getMainStoryStageForRequest({ stageID: requestedStageId, dungeonID: 0 })) ||
      getMainStoryStageForRequest(req) ||
      getTutorialStageForRequest(req) ||
      (ctx.getGenericStageForRequest ? ctx.getGenericStageForRequest(req) : null);
    if (stage) {
      req.stageID = stage.stageId;
      req.dungeonID = stage.dungeonID;
    }
    if (socket.session && socket.session.gameReplay) {
      socket.session.gameReplay.lastGameLoadReq = {
        stageID: Number((req && req.stageID) || 0),
        dungeonID: Number((req && req.dungeonID) || 0),
      };
    }
    const eventDeckId = stage ? Number(stage.eventDeckId || stage.EventDeckId || 0) : 0;
    const usesEventDeck = eventDeckId > 0;
    const eventDeckPlayerUnitSlots = usesEventDeck ? getEventDeckPlayerUnitSlots(eventDeckId) : [];
    const eventDeckAllowsPlayerUnits = eventDeckPlayerUnitSlots.length > 0;
    const usesHybridEventDeck = eventDeckAllowsPlayerUnits && eventDeckHasGivenUnitSlots(eventDeckId);
    const user = socket.session && socket.session.user;
    let playerDeck = null;
    if (stage && !stage.cutsceneOnly) {
      if (stage.tutorial || (usesEventDeck && !eventDeckAllowsPlayerUnits)) {
        playerDeck = buildPlayerIdentityForGameLoad(user);
      } else if (eventDeckAllowsPlayerUnits) {
        const eventDeckSelection = req && req.eventDeckData ? req.eventDeckData : null;
        playerDeck =
          buildPlayerDeckForGameLoad(user, req, {
            allowedUnitSlots: eventDeckPlayerUnitSlots,
            slotUnitUids: eventDeckSelection && eventDeckSelection.units,
            shipUid: eventDeckSelection && eventDeckSelection.shipUid,
            operatorUid: eventDeckSelection && eventDeckSelection.operatorUid,
            leaderIndex: eventDeckSelection && eventDeckSelection.leaderIndex,
          }) || buildPlayerIdentityForGameLoad(user);
      } else {
        playerDeck = buildPlayerDeckForGameLoad(user, req) || buildPlayerIdentityForGameLoad(user);
      }
    }
    if (playerDeck && !stage.tutorial && playerDeck.units && playerDeck.units.length) {
      console.log(
        `[game-load] selectedDeck deckType=${playerDeck.deckType} index=${playerDeck.deckIndex} ${
          usesEventDeck
            ? `eventDeck=${eventDeckId} playerSlots=${eventDeckPlayerUnitSlots.join("/") || "none"} source=${
                req && req.eventDeckData ? "eventDeckData" : "deck"
              } `
            : ""
        }units=${playerDeck.units
          .map((unit) => `${unit.slotIndex}:${unit.unitId}/${unit.unitUid}`)
          .join(",")} ship=${playerDeck.shipUnitId}/${playerDeck.shipUid} operator=${playerDeck.operatorId}/${playerDeck.operatorUid}`
      );
    } else if (stage && usesEventDeck) {
      console.log(`[game-load] eventDeck=${stage.eventDeckId || stage.EventDeckId} stageID=${stage.stageId} dungeonID=${stage.dungeonID}`);
    }
    const activeStage =
      stage && !stage.cutsceneOnly
        ? {
            ...stage,
            eventDeckFreeUnitSlots: eventDeckPlayerUnitSlots,
            usesHybridEventDeck,
            eventDeckFreeShipSlot: usesEventDeck ? eventDeckHasFreeShipSlot(eventDeckId) : false,
            playerDeck,
          }
        : stage;
    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      ctx.logCapturedClientPacketMatch(packet, 10, "game-load");
    }
    if (!activeStage || activeStage.tutorial) ctx.maybeSendTutorialCutsceneClear(socket, packet.payload);
    if (ctx.config.DYNAMIC_BATTLE_MANAGER && activeStage && !activeStage.cutsceneOnly && ctx.sendDynamicGameLoadAck(socket, req, activeStage)) {
      return true;
    }
    if (ctx.config.REPLAY_CAPTURED_GAME_FLOW && ctx.capturedGameFlow) {
      ctx.sendCapturedGameThroughPacketId(socket, ctx.constants.GAME_LOAD_ACK, "game-load");
      ctx.scheduleCapturedGameAutoAdvance(socket);
      return true;
    }
    return false;
  },
};

function buildPlayerIdentityForGameLoad(user) {
  if (!user) return null;
  return {
    userUid: String(user.userUid || "0"),
    nickname: String(user.nickname || "LocalAdmin"),
    userLevel: Number(user.level || 1),
    units: [],
  };
}
