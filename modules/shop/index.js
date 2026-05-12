const fs = require("fs");
const path = require("path");
const { getMiscItem, spendMiscItem, toBigInt } = require("../inventory");
const { buildUnitData, buildOperatorData, buildEquipItemData } = require("../packet-codec");
const { grantRewardByType, mergeReward } = require("../reward");
const {
  createEmptyReward,
  isRealMoneyResourceProduct,
  grantShopProduct,
  spendShopPrice,
  grantFallbackResource,
  getPurchaseKey,
  hasCompletedPurchase,
  markCompletedPurchase,
  makeLocalOrderId,
} = require("../resource");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DOTNET_TICKS_AT_UNIX_EPOCH = 621355968000000000n;
const TICKS_PER_MS = 10000n;
const TICKS_PER_HOUR = 60n * 60n * 10000000n;
const RANDOM_SHOP_SLOT_COUNT = readPositiveIntEnv("CS_RANDOM_SHOP_SLOT_COUNT", 9);
const RANDOM_SHOP_REFRESH_INTERVAL_HOURS = readPositiveIntEnv("CS_RANDOM_SHOP_REFRESH_INTERVAL_HOURS", 6);
const RANDOM_SHOP_REFRESH_COST_ITEM_ID = readPositiveIntEnv("CS_RANDOM_SHOP_REFRESH_COST_ITEM_ID", 101);
const RANDOM_SHOP_REFRESH_COST = readNonNegativeIntEnv("CS_RANDOM_SHOP_REFRESH_COST", 15);
const RANDOM_SHOP_REFRESH_MAX_COUNT = readNonNegativeIntEnv("CS_RANDOM_SHOP_REFRESH_MAX_COUNT", 5);
const RANDOM_SHOP_STATE_VERSION = 1;
const ERROR_CODES = Object.freeze({
  OK: 0,
  INSUFFICIENT_CASH: 96,
  INSUFFICIENT_RESOURCE: 110,
  INVALID_SHOP_ID: 252,
  NOT_ENOUGH_REFRESH_COUNT: 257,
});
const REWARD_TYPE_VALUES = Object.freeze({
  RT_NONE: 0,
  RT_UNIT: 1,
  RT_SHIP: 2,
  RT_MISC: 3,
  RT_USER_EXP: 4,
  RT_EQUIP: 5,
  RT_MOLD: 6,
  RT_SKIN: 7,
  RT_BUFF: 8,
  RT_EMOTICON: 9,
  RT_MISSION_POINT: 10,
  RT_BINGO_TILE: 11,
  RT_PASS_EXP: 12,
  RT_OPERATOR: 13,
});
const RANDOM_SHOP_POOL = Object.freeze([
  { itemType: "RT_MISC", itemId: 2, itemCount: 1200, priceItemId: 1, price: 18000, weight: 12 },
  { itemType: "RT_MISC", itemId: 2, itemCount: 3000, priceItemId: 1, price: 42000, weight: 7, discountRatio: 10 },
  { itemType: "RT_MISC", itemId: 3, itemCount: 600, priceItemId: 1, price: 16000, weight: 10 },
  { itemType: "RT_MISC", itemId: 1001, itemCount: 1, priceItemId: 1, price: 35000, weight: 8 },
  { itemType: "RT_MISC", itemId: 1001, itemCount: 3, priceItemId: 1, price: 90000, weight: 4, discountRatio: 15 },
  { itemType: "RT_MISC", itemId: 1013, itemCount: 8, priceItemId: 1, price: 26000, weight: 7 },
  { itemType: "RT_MISC", itemId: 1003, itemCount: 3, priceItemId: 1, price: 30000, weight: 5 },
  { itemType: "RT_MISC", itemId: 1005, itemCount: 3, priceItemId: 1, price: 30000, weight: 5 },
  { itemType: "RT_MISC", itemId: 1007, itemCount: 3, priceItemId: 1, price: 30000, weight: 5 },
  { itemType: "RT_MISC", itemId: 1034, itemCount: 1, priceItemId: 101, price: 80, weight: 3 },
  { itemType: "RT_UNIT", itemId: 101, itemCount: 1, priceItemId: 1, price: 12000, weight: 7 },
  { itemType: "RT_UNIT", itemId: 102, itemCount: 1, priceItemId: 1, price: 28000, weight: 5 },
  { itemType: "RT_UNIT", itemId: 103, itemCount: 1, priceItemId: 1, price: 60000, weight: 3, discountRatio: 10 },
  { itemType: "RT_UNIT", itemId: 111, itemCount: 1, priceItemId: 1, price: 12000, weight: 7 },
  { itemType: "RT_UNIT", itemId: 112, itemCount: 1, priceItemId: 1, price: 28000, weight: 5 },
  { itemType: "RT_UNIT", itemId: 121, itemCount: 1, priceItemId: 1, price: 12000, weight: 7 },
  { itemType: "RT_UNIT", itemId: 131, itemCount: 1, priceItemId: 1, price: 12000, weight: 7 },
  { itemType: "RT_UNIT", itemId: 141, itemCount: 1, priceItemId: 1, price: 12000, weight: 7 },
]);
const PACKETS = Object.freeze({
  SHOP_FIX_SHOP_BUY_REQ: 2400,
  SHOP_FIX_SHOP_CASH_BUY_REQ: 2401,
  SHOP_FIX_SHOP_BUY_ACK: 2402,
  SHOP_RANDOM_SHOP_BUY_REQ: 2403,
  SHOP_RANDOM_SHOP_BUY_ACK: 2404,
  SHOP_FIXED_LIST_REQ: 2405,
  SHOP_FIXED_LIST_ACK: 2406,
  SHOP_REFRESH_REQ: 2407,
  SHOP_REFRESH_ACK: 2408,
  SHOP_FIX_SHOP_CASH_BUY_POSSIBLE_REQ: 2410,
  SHOP_FIX_SHOP_CASH_BUY_POSSIBLE_ACK: 2411,
  SHOP_CHAIN_TAB_RESET_TIME_REQ: 2412,
  SHOP_CHAIN_TAB_RESET_TIME_ACK: 2413,
  SHOP_BUY_BUNDLE_TAB_REQ: 2414,
  SHOP_BUY_BUNDLE_TAB_ACK: 2415,
  ZLONG_USE_COUPON_REQ: 2417,
  ZLONG_USE_COUPON_ACK: 2418,
  ZLONG_USE_COUPON_REQ2: 2419,
  GAMEBASE_BUY_REQ: 2420,
  GAMEBASE_BUY_ACK: 2421,
  STEAM_BUY_INIT_REQ: 2424,
  STEAM_BUY_INIT_ACK: 2425,
  STEAM_BUY_REQ: 2426,
  SHOP_RANDOM_SHOP_BUY_LIST_REQ: 2428,
  SHOP_RANDOM_SHOP_BUY_LIST_ACK: 2429,
});

const SHOP_TEMPLET_FILES = [
  path.join(ROOT_DIR, "gameplay-tables-json", "StreamingAssets", "ab_script", "luac", "LUA_SHOP_TEMPLET_01.json"),
  path.join(ROOT_DIR, "gameplay-tables-json", "StreamingAssets", "ab_script", "luac", "LUA_SHOP_TEMPLET_02.json"),
  path.join(ROOT_DIR, "gameplay-tables-json", "Assetbundles", "ab_script", "luac", "LUA_SHOP_TEMPLET_01.json"),
  path.join(ROOT_DIR, "gameplay-tables-json", "Assetbundles", "ab_script", "luac", "LUA_SHOP_TEMPLET_02.json"),
];

let cachedCatalog = null;
const INCLUDE_BEGINNER_PACKS = process.env.CS_SHOP_INCLUDE_BEGINNER_PACKS === "1";
function createShopHandler(packetId, name) {
  return {
    packetId,
    name,
    handle(ctx, socket, packet) {
      ctx.socket = socket;
      const request = decodeShopRequest(ctx, packetId, packet.payload);
      const response = buildShopResponse(ctx, packetId, request);
      if (!response) return false;
      console.log(`[shop:${name}] ACK packetId=${response.packetId} ${formatShopRequest(request)}`);
      ctx.sendResponse(socket, packet.sequence, response.packetId, () =>
        ctx.buildEncryptedPacket(packet.sequence, response.packetId, response.payload)
      );
      return true;
    },
  };
}

function buildCashBuyPossibleResponse(ctx, request) {
  const productMarketID = request.productMarketID || "";
  const productId = resolveProductId(findProductIdByMarketId(productMarketID));
  const record = findProductRecord(productId);
  if (isRealMoneyResourceProduct(record)) {
    console.log(`[resource] bypass real-money validation productId=${productId} marketId=${JSON.stringify(productMarketID)}`);
    return {
      packetId: PACKETS.SHOP_FIX_SHOP_BUY_ACK,
      payload: buildShopFixBuyAck(ctx, request, productId, { source: "cash", dedupe: false }),
    };
  }
  return {
    packetId: PACKETS.SHOP_FIX_SHOP_CASH_BUY_POSSIBLE_ACK,
    payload: buildCashBuyPossibleAck(ctx, productMarketID, request.selectIndices || [], productId),
  };
}

function buildSteamBuyInitResponse(ctx, request) {
  const productId = resolveProductId(request.productId || 0);
  const record = findProductRecord(productId);
  if (isRealMoneyResourceProduct(record)) {
    console.log(`[resource] bypass Steam validation productId=${productId}`);
    return {
      packetId: PACKETS.SHOP_FIX_SHOP_BUY_ACK,
      payload: buildShopFixBuyAck(ctx, request, productId, { source: "steam", dedupe: false }),
    };
  }
  return {
    packetId: PACKETS.STEAM_BUY_INIT_ACK,
    payload: buildSteamBuyInitAck(ctx, productId),
  };
}

function buildShopResponse(ctx, packetId, request) {
  switch (packetId) {
    case PACKETS.SHOP_FIXED_LIST_REQ:
      return {
        packetId: PACKETS.SHOP_FIXED_LIST_ACK,
        payload: buildShopFixedListAck(ctx),
      };
    default:
      return buildShopResponseInner(ctx, packetId, request);
  }
}

function buildShopResponseInner(ctx, packetId, request) {
  switch (packetId) {
    case PACKETS.SHOP_FIX_SHOP_BUY_REQ:
      return {
        packetId: PACKETS.SHOP_FIX_SHOP_BUY_ACK,
        payload: buildShopFixBuyAck(ctx, request, resolveProductId(request.productID)),
      };
    case PACKETS.SHOP_FIX_SHOP_CASH_BUY_REQ:
      return {
        packetId: PACKETS.SHOP_FIX_SHOP_BUY_ACK,
        payload: buildShopFixBuyAck(ctx, request, resolveProductId(findProductIdByMarketId(request.productMarketID)), {
          source: "cash",
          dedupe: false,
        }),
      };
    case PACKETS.GAMEBASE_BUY_REQ:
      return {
        packetId: PACKETS.GAMEBASE_BUY_ACK,
        payload: buildGamebaseBuyAck(
          ctx,
          request,
          resolveProductId(
            findProductIdByPaymentId(request.paymentId) ||
              findProductIdByPaymentId(request.paymentSeq) ||
              findProductIdByMarketId(request.paymentId)
          )
        ),
      };
    case PACKETS.STEAM_BUY_REQ:
      return {
        packetId: PACKETS.SHOP_FIX_SHOP_BUY_ACK,
        payload: buildShopFixBuyAck(ctx, request, resolveProductId(request.productId), { source: "steam" }),
      };
    case PACKETS.SHOP_RANDOM_SHOP_BUY_REQ:
      return {
        packetId: PACKETS.SHOP_RANDOM_SHOP_BUY_ACK,
        payload: buildRandomShopBuyAck(ctx, request.slotIndex || 0),
      };
    case PACKETS.SHOP_RANDOM_SHOP_BUY_LIST_REQ:
      return {
        packetId: PACKETS.SHOP_RANDOM_SHOP_BUY_LIST_ACK,
        payload: buildRandomShopBuyListAck(ctx, request.slotIndexes || []),
      };
    case PACKETS.SHOP_REFRESH_REQ:
      return {
        packetId: PACKETS.SHOP_REFRESH_ACK,
        payload: buildShopRefreshAck(ctx, request),
      };
    case PACKETS.SHOP_FIX_SHOP_CASH_BUY_POSSIBLE_REQ:
      return buildCashBuyPossibleResponse(ctx, request);
    case PACKETS.STEAM_BUY_INIT_REQ:
      return buildSteamBuyInitResponse(ctx, request);
    case PACKETS.SHOP_CHAIN_TAB_RESET_TIME_REQ:
      return {
        packetId: PACKETS.SHOP_CHAIN_TAB_RESET_TIME_ACK,
        payload: Buffer.concat([ctx.writeSignedVarInt(0), writeObjectList([])]),
      };
    case PACKETS.SHOP_BUY_BUNDLE_TAB_REQ:
      return {
        packetId: PACKETS.SHOP_BUY_BUNDLE_TAB_ACK,
        payload: buildBundleTabBuyAck(ctx),
      };
    case PACKETS.ZLONG_USE_COUPON_REQ:
    case PACKETS.ZLONG_USE_COUPON_REQ2:
      return {
        packetId: PACKETS.ZLONG_USE_COUPON_ACK,
        payload: buildCouponAck(ctx),
      };
    default:
      return null;
  }
}

function buildShopFixedListAck(ctx) {
  const productIds = loadShopCatalog().productIds;
  return Buffer.concat([
    ctx.writeSignedVarInt(0),
    writeIntList(ctx, productIds),
    writeObjectList([]), // InstantProductList
  ]);
}

function buildShopFixBuyAck(ctx, request, productId, options = {}) {
  const result = options.skipGrant
    ? { reward: createEmptyReward(), costItem: null }
    : processProductPurchase(ctx, productId, request && request.productCount, {
        source: options.source || "shop-buy",
        request,
        dedupe: options.dedupe,
      });
  return Buffer.concat([
    ctx.writeSignedVarInt(0),
    writeNullableObject(buildRewardData(ctx, result.reward)),
    ctx.writeSignedVarInt(productId || 0),
    writeNullableObject(buildPurchaseHistory(ctx, productId || 0, request && request.productCount)),
    writeNullableObjectOrNull(result.costItem ? buildItemMiscData(ctx, result.costItem) : null), // costItemData
    writeNullObject(), // subscriptionData
    writeDoubleLE(0),
  ]);
}

function buildGamebaseBuyAck(ctx, request, productId) {
  const result = processProductPurchase(ctx, productId, request && request.productCount, {
    source: "gamebase",
    request,
  });
  return Buffer.concat([
    ctx.writeSignedVarInt(0),
    writeNullableObject(buildRewardData(ctx, result.reward)),
    ctx.writeSignedVarInt(productId || 0),
    writeNullableObject(buildPurchaseHistory(ctx, productId || 0, request && request.productCount)),
    writeNullableObjectOrNull(result.costItem ? buildItemMiscData(ctx, result.costItem) : null), // costItemData
    writeNullObject(), // subscriptionData
    writeDoubleLE(0),
  ]);
}

function buildRandomShopBuyAck(ctx, slotIndex) {
  const result = processRandomShopPurchase(ctx, [slotIndex || 0]);
  return Buffer.concat([
    ctx.writeSignedVarInt(result.errorCode),
    ctx.writeSignedVarInt(slotIndex || 0),
    writeNullableObject(buildRewardData(ctx, result.reward)),
    writeNullableObjectOrNull(result.costItems[0] ? buildItemMiscData(ctx, result.costItems[0]) : null),
  ]);
}

function buildRandomShopBuyListAck(ctx, slotIndexes) {
  const result = processRandomShopPurchase(ctx, slotIndexes || []);
  return Buffer.concat([
    ctx.writeSignedVarInt(result.errorCode),
    writeIntList(ctx, slotIndexes),
    writeNullableObject(buildRewardData(ctx, result.reward)),
    writeObjectList(result.costItems.map((item) => writeNullableObject(buildItemMiscData(ctx, item)))),
  ]);
}

function buildShopRefreshAck(ctx, request = {}) {
  const result = refreshRandomShop(ctx, Boolean(request && request.isUseCash));
  return Buffer.concat([
    ctx.writeSignedVarInt(result.errorCode),
    result.randomShop ? writeNullableObject(buildRandomShopData(result.randomShop)) : writeNullObject(),
    writeNullableObjectOrNull(result.costItem ? buildItemMiscData(ctx, result.costItem) : null),
  ]);
}

function buildCashBuyPossibleAck(ctx, productMarketID, selectIndices, productId = 0) {
  return Buffer.concat([
    ctx.writeSignedVarInt(0),
    writeString(productMarketID || ""),
    writeNullableObject(buildPurchaseHistory(ctx, productId || 0, 0)),
    writeIntList(ctx, selectIndices),
  ]);
}

function buildBundleTabBuyAck(ctx) {
  const reward = grantFallbackReward(ctx);
  return Buffer.concat([
    ctx.writeSignedVarInt(0),
    writeNullableObject(buildRewardData(ctx, reward)),
    writeNullObject(), // costItemData
    writeObjectList([]), // history
    writeObjectList([]), // subscriptionData
  ]);
}

function buildCouponAck(ctx) {
  const reward = grantFallbackReward(ctx);
  return Buffer.concat([
    ctx.writeSignedVarInt(0),
    ctx.writeSignedVarInt(0), // zlongInfoCode
    writeNullableObject(buildRewardData(ctx, reward)),
  ]);
}

function buildSteamBuyInitAck(ctx, productId) {
  return Buffer.concat([
    ctx.writeSignedVarInt(0),
    ctx.writeSignedVarInt(productId || 0),
    writeString(makeLocalOrderId(productId)),
  ]);
}

function buildSerializedRandomShopData(user, options = {}) {
  return buildRandomShopData(ensureRandomShopState(user, options));
}

function buildRandomShopData(randomShop) {
  const state = randomShop && typeof randomShop === "object" ? randomShop : createFreshRandomShopState(null, utcTicksNow());
  const slots = normalizeRandomShopSlots(state.slots);
  const entries = Object.entries(slots)
    .map(([index, slot]) => [Number(index), buildRandomShopListData(slot)])
    .sort((a, b) => a[0] - b[0]);
  return Buffer.concat([
    writeObjectMapInt(entries),
    writeSignedVarLong(toBigInt(state.nextRefreshDate || 0, 0n)),
    writeSignedVarInt(Number(state.refreshCount || 0)),
  ]);
}

function buildRandomShopListData(slot) {
  const data = slot || {};
  return Buffer.concat([
    writeSignedVarInt(Number(data.itemId || 0)),
    writeSignedVarInt(rewardTypeValue(data.itemType)),
    writeSignedVarInt(Number(data.itemCount || 0)),
    writeSignedVarInt(Number(data.priceItemId || 0)),
    writeSignedVarInt(Number(data.price || 0)),
    writeBool(Boolean(data.isBuy)),
    writeSignedVarInt(Number(data.discountRatio || 0)),
  ]);
}

function refreshRandomShop(ctx, useCash) {
  const user = getSessionUser(ctx);
  const now = utcTicksNow();
  const state = ensureRandomShopState(user, { now, autoRefresh: false });
  let costItem = null;

  if (useCash) {
    resetRandomShopRefreshCount(state, now);
    if (Number(state.refreshCount || 0) <= 0) {
      return { errorCode: ERROR_CODES.NOT_ENOUGH_REFRESH_COUNT, randomShop: state, costItem: null };
    }
    if (!hasEnoughMiscItem(user, RANDOM_SHOP_REFRESH_COST_ITEM_ID, RANDOM_SHOP_REFRESH_COST)) {
      return { errorCode: ERROR_CODES.INSUFFICIENT_CASH, randomShop: state, costItem: null };
    }
    costItem = spendMiscItem(user, RANDOM_SHOP_REFRESH_COST_ITEM_ID, RANDOM_SHOP_REFRESH_COST, {
      regDate: currentDateTimeBinary(ctx),
    });
    state.refreshCount = Math.max(0, Number(state.refreshCount || 0) - 1);
  } else if (!isRandomShopExpired(state, now) && Object.keys(normalizeRandomShopSlots(state.slots)).length > 0) {
    return { errorCode: ERROR_CODES.OK, randomShop: state, costItem: null };
  }

  rotateRandomShopState(user, state, now);
  persistUserDb(ctx);
  return { errorCode: ERROR_CODES.OK, randomShop: state, costItem };
}

function processRandomShopPurchase(ctx, slotIndexes) {
  const user = getSessionUser(ctx);
  const state = ensureRandomShopState(user);
  const requested = uniquePositiveInts(slotIndexes);
  const slots = normalizeRandomShopSlots(state.slots);
  if (!requested.length) return randomShopPurchaseResult(ERROR_CODES.INVALID_SHOP_ID);

  const selected = [];
  for (const index of requested) {
    const slot = slots[String(index)];
    if (!slot || slot.isBuy) return randomShopPurchaseResult(ERROR_CODES.INVALID_SHOP_ID);
    selected.push([index, slot]);
  }

  const pricesByItemId = new Map();
  for (const [, slot] of selected) {
    const priceItemId = Number(slot.priceItemId || 0);
    const price = getRandomShopSlotPrice(slot);
    if (priceItemId > 0 && price > 0) {
      pricesByItemId.set(priceItemId, (pricesByItemId.get(priceItemId) || 0) + price);
    }
  }
  for (const [priceItemId, totalPrice] of pricesByItemId) {
    if (!hasEnoughMiscItem(user, priceItemId, totalPrice)) {
      return randomShopPurchaseResult(priceItemId === RANDOM_SHOP_REFRESH_COST_ITEM_ID ? ERROR_CODES.INSUFFICIENT_CASH : ERROR_CODES.INSUFFICIENT_RESOURCE);
    }
  }

  const reward = createEmptyReward();
  const regDate = currentDateTimeBinary(ctx);
  for (const [, slot] of selected) {
    mergeReward(
      reward,
      grantRewardByType(ctx, user, slot.itemType, slot.itemId, slot.itemCount, slot.itemCount, 0n, {
        regDate,
        expandPackages: false,
      })
    );
    slot.isBuy = true;
  }

  const costItems = [];
  for (const [priceItemId, totalPrice] of pricesByItemId) {
    const costItem = spendMiscItem(user, priceItemId, totalPrice, { regDate });
    if (costItem) costItems.push(costItem);
  }
  state.slots = slots;
  persistUserDb(ctx);
  return randomShopPurchaseResult(ERROR_CODES.OK, reward, costItems);
}

function randomShopPurchaseResult(errorCode, reward = createEmptyReward(), costItems = []) {
  return { errorCode, reward, costItems: Array.isArray(costItems) ? costItems : [] };
}

function ensureRandomShopState(user, options = {}) {
  const now = toRawTicks(options.now || utcTicksNow());
  const state = normalizeRandomShopState(user ? user.randomShop : null, user, now);
  resetRandomShopRefreshCount(state, now);
  if (options.autoRefresh !== false && isRandomShopExpired(state, now)) {
    rotateRandomShopState(user, state, now);
  }
  if (user && typeof user === "object") user.randomShop = state;
  return state;
}

function normalizeRandomShopState(existing, user, now) {
  const state = existing && typeof existing === "object" ? existing : {};
  state.version = RANDOM_SHOP_STATE_VERSION;
  state.generation = Math.max(0, Number(state.generation || 0));
  state.refreshCount = clampRefreshCount(state.refreshCount);
  state.refreshDay = state.refreshDay || utcDayKey(now);
  state.nextRefreshDate = String(toRawTicks(state.nextRefreshDate || 0n));
  state.slots = normalizeRandomShopSlots(state.slots);
  if (!Object.keys(state.slots).length || toRawTicks(state.nextRefreshDate) <= 0n) {
    rotateRandomShopState(user, state, now);
  }
  return state;
}

function rotateRandomShopState(user, state, now = utcTicksNow()) {
  const rawNow = toRawTicks(now);
  state.version = RANDOM_SHOP_STATE_VERSION;
  state.generation = Math.max(0, Number(state.generation || 0)) + 1;
  state.refreshDay = state.refreshDay || utcDayKey(rawNow);
  state.slots = createRandomShopSlots(user, state.generation, rawNow);
  state.nextRefreshDate = String(nextRandomShopRefreshTicks(rawNow));
  return state;
}

function createFreshRandomShopState(user, now = utcTicksNow()) {
  const state = {
    version: RANDOM_SHOP_STATE_VERSION,
    generation: 0,
    refreshCount: RANDOM_SHOP_REFRESH_MAX_COUNT,
    refreshDay: utcDayKey(now),
    nextRefreshDate: "0",
    slots: {},
  };
  return rotateRandomShopState(user, state, now);
}

function createRandomShopSlots(user, generation, now) {
  const seed = hashString(`${user && user.userUid ? user.userUid : "local"}:${generation}:${randomShopIntervalBucket(now)}`);
  const rng = mulberry32(seed);
  let pool = RANDOM_SHOP_POOL.map((entry) => ({ ...entry }));
  const slots = {};
  for (let index = 1; index <= RANDOM_SHOP_SLOT_COUNT; index += 1) {
    if (!pool.length) pool = RANDOM_SHOP_POOL.map((entry) => ({ ...entry }));
    const pickedIndex = pickWeightedIndex(pool, rng);
    const picked = pool.splice(pickedIndex, 1)[0] || RANDOM_SHOP_POOL[0];
    slots[String(index)] = normalizeRandomShopSlot(picked);
  }
  return slots;
}

function normalizeRandomShopSlots(slots) {
  const source = slots && typeof slots === "object" ? slots : {};
  const normalized = {};
  for (const [key, value] of Object.entries(source)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index <= 0) continue;
    const slot = normalizeRandomShopSlot(value);
    if (slot.itemId <= 0 || rewardTypeValue(slot.itemType) <= 0) continue;
    normalized[String(index)] = slot;
  }
  return normalized;
}

function normalizeRandomShopSlot(slot) {
  const data = slot && typeof slot === "object" ? slot : {};
  return {
    itemId: Math.max(0, Number(data.itemId || data.itemID || 0) | 0),
    itemType: normalizeRewardType(data.itemType),
    itemCount: Math.max(1, Number(data.itemCount || data.count || 1) | 0),
    priceItemId: Math.max(0, Number(data.priceItemId || data.priceItemID || 0) | 0),
    price: Math.max(0, Number(data.price || 0) | 0),
    isBuy: Boolean(data.isBuy),
    discountRatio: Math.max(0, Math.min(100, Number(data.discountRatio || 0) | 0)),
  };
}

function resetRandomShopRefreshCount(state, now) {
  const day = utcDayKey(now);
  if (state.refreshDay !== day) {
    state.refreshDay = day;
    state.refreshCount = RANDOM_SHOP_REFRESH_MAX_COUNT;
  } else {
    state.refreshCount = clampRefreshCount(state.refreshCount);
  }
}

function clampRefreshCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return RANDOM_SHOP_REFRESH_MAX_COUNT;
  return Math.max(0, Math.min(RANDOM_SHOP_REFRESH_MAX_COUNT, Math.trunc(count)));
}

function isRandomShopExpired(state, now) {
  const nextRefreshDate = toRawTicks(state && state.nextRefreshDate);
  return nextRefreshDate <= 0n || nextRefreshDate <= toRawTicks(now);
}

function nextRandomShopRefreshTicks(now) {
  const intervalTicks = BigInt(Math.max(1, Math.trunc(RANDOM_SHOP_REFRESH_INTERVAL_HOURS))) * TICKS_PER_HOUR;
  const elapsed = toRawTicks(now) - DOTNET_TICKS_AT_UNIX_EPOCH;
  return DOTNET_TICKS_AT_UNIX_EPOCH + ((elapsed / intervalTicks) + 1n) * intervalTicks;
}

function randomShopIntervalBucket(now) {
  const intervalTicks = BigInt(Math.max(1, Math.trunc(RANDOM_SHOP_REFRESH_INTERVAL_HOURS))) * TICKS_PER_HOUR;
  return String((toRawTicks(now) - DOTNET_TICKS_AT_UNIX_EPOCH) / intervalTicks);
}

function utcDayKey(ticks) {
  const ms = Number((toRawTicks(ticks) - DOTNET_TICKS_AT_UNIX_EPOCH) / TICKS_PER_MS);
  return new Date(ms).toISOString().slice(0, 10);
}

function utcTicksNow() {
  return BigInt(Date.now()) * TICKS_PER_MS + DOTNET_TICKS_AT_UNIX_EPOCH;
}

function toRawTicks(value) {
  try {
    return BigInt(value || 0);
  } catch (_) {
    return 0n;
  }
}

function currentDateTimeBinary(ctx) {
  return ctx && typeof ctx.dateTimeBinaryNow === "function" ? ctx.dateTimeBinaryNow() : 0n;
}

function readPositiveIntEnv(name, fallback) {
  const value = Number(process.env[name] == null ? fallback : process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function readNonNegativeIntEnv(name, fallback) {
  const value = Number(process.env[name] == null ? fallback : process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

function getRandomShopSlotPrice(slot) {
  const price = Math.max(0, Number(slot && slot.price) || 0);
  const discountRatio = Math.max(0, Math.min(100, Number(slot && slot.discountRatio) || 0));
  return Math.floor((price * (100 - discountRatio)) / 100);
}

function hasEnoughMiscItem(user, itemId, amount) {
  const required = toBigInt(amount, 0n);
  if (required <= 0n) return true;
  const item = getMiscItem(user, itemId);
  const available = toBigInt(item && item.countFree, 0n) + toBigInt(item && item.countPaid, 0n);
  return available >= required;
}

function rewardTypeValue(type) {
  return REWARD_TYPE_VALUES[normalizeRewardType(type)] || 0;
}

function normalizeRewardType(type) {
  const text = String(type || "RT_MISC").toUpperCase();
  return REWARD_TYPE_VALUES[text] == null ? "RT_MISC" : text;
}

function uniquePositiveInts(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [values])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

function pickWeightedIndex(pool, rng) {
  const total = pool.reduce((sum, entry) => sum + Math.max(1, Number(entry.weight || 1)), 0);
  let roll = rng() * total;
  for (let index = 0; index < pool.length; index += 1) {
    roll -= Math.max(1, Number(pool[index].weight || 1));
    if (roll <= 0) return index;
  }
  return Math.max(0, pool.length - 1);
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = Number(seed) >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function decodeShopRequest(ctx, packetId, encryptedPayload) {
  const payload = safeDecrypt(ctx, encryptedPayload);
  const reader = createReader(payload);
  try {
    switch (packetId) {
      case PACKETS.SHOP_FIX_SHOP_BUY_REQ:
        return {
          productID: reader.int(),
          productCount: reader.int(),
          selectIndices: reader.intList(),
        };
      case PACKETS.SHOP_FIX_SHOP_CASH_BUY_REQ:
        return {
          productMarketID: reader.string(),
          validationToken: reader.string(),
          realCash: reader.double(),
          currencyType: reader.int(),
          currencyCode: reader.string(),
          selectIndices: reader.intList(),
        };
      case PACKETS.SHOP_RANDOM_SHOP_BUY_REQ:
        return { slotIndex: reader.int() };
      case PACKETS.SHOP_REFRESH_REQ:
        return { isUseCash: reader.bool() };
      case PACKETS.SHOP_FIX_SHOP_CASH_BUY_POSSIBLE_REQ:
        return {
          productMarketID: reader.string(),
          selectIndices: reader.intList(),
        };
      case PACKETS.SHOP_BUY_BUNDLE_TAB_REQ:
        return {
          tabType: reader.string(),
          subIndex: reader.int(),
        };
      case PACKETS.ZLONG_USE_COUPON_REQ:
        return { couponCode: reader.string() };
      case PACKETS.ZLONG_USE_COUPON_REQ2:
        return {
          couponCode: reader.string(),
          zlongServerId: reader.int(),
        };
      case PACKETS.GAMEBASE_BUY_REQ:
        return {
          paymentSeq: reader.string(),
          accessToken: reader.string(),
          selectIndices: reader.intList(),
          paymentId: reader.string(),
        };
      case PACKETS.STEAM_BUY_INIT_REQ:
        return {
          steamId: reader.string(),
          productId: reader.int(),
          language: reader.string(),
          country: reader.string(),
          itemShopDesc: reader.string(),
        };
      case PACKETS.STEAM_BUY_REQ:
        return {
          steamId: reader.string(),
          orderId: reader.string(),
          productId: reader.int(),
          country: reader.string(),
          currency: reader.string(),
          selectIndices: reader.intList(),
        };
      case PACKETS.SHOP_RANDOM_SHOP_BUY_LIST_REQ:
        return { slotIndexes: reader.intList() };
      default:
        return {};
    }
  } catch (err) {
    console.log(`[shop] request decode failed packetId=${packetId}: ${err.message}`);
    return {};
  }
}

function safeDecrypt(ctx, payload) {
  try {
    return ctx.decryptCopy(payload);
  } catch (_) {
    return Buffer.alloc(0);
  }
}

function createReader(buffer) {
  let offset = 0;
  return {
    int() {
      const read = readSignedVarInt(buffer, offset);
      offset = read.offset;
      return read.value;
    },
    string() {
      const length = readSignedVarInt(buffer, offset);
      offset = length.offset;
      if (length.value < 0) return "";
      const end = Math.min(buffer.length, offset + length.value);
      const value = buffer.subarray(offset, end).toString("utf8");
      offset = end;
      return value;
    },
    intList() {
      const count = readVarInt(buffer, offset);
      offset = count.offset;
      const values = [];
      for (let index = 0; index < count.value; index += 1) {
        const read = readSignedVarInt(buffer, offset);
        offset = read.offset;
        values.push(read.value);
      }
      return values;
    },
    bool() {
      if (offset >= buffer.length) return false;
      return buffer.readUInt8(offset++) !== 0;
    },
    double() {
      if (offset + 8 > buffer.length) return 0;
      const value = buffer.readDoubleLE(offset);
      offset += 8;
      return value;
    },
  };
}

function loadShopCatalog() {
  if (cachedCatalog) return cachedCatalog;
  const productIds = new Set();
  const marketToProductId = new Map();
  const recordsByProductId = new Map();
  const priceItemIds = new Set();
  let suppressedProducts = 0;

  for (const filePath of SHOP_TEMPLET_FILES) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      for (const record of parsed.records || []) {
        const productId = Number(record && record.m_ProductID);
        if (!Number.isInteger(productId) || productId <= 0) continue;
        recordsByProductId.set(productId, pickPreferredProductRecord(recordsByProductId.get(productId), record));
        const priceItemId = Number(record && record.m_PriceItemID);
        if (Number.isInteger(priceItemId) && priceItemId > 0) priceItemIds.add(priceItemId);
        if (shouldSuppressShopProduct(record)) {
          suppressedProducts += 1;
          continue;
        }
        productIds.add(productId);
        if (record.m_MarketID != null && String(record.m_MarketID).length > 0) {
          marketToProductId.set(String(record.m_MarketID), productId);
        }
      }
    } catch (err) {
      console.log(`[shop] failed to load ${filePath}: ${err.message}`);
    }
  }

  cachedCatalog = {
    productIds: Array.from(productIds).sort((a, b) => a - b),
    marketToProductId,
    recordsByProductId,
    priceItemIds: Array.from(priceItemIds).sort((a, b) => a - b),
  };
  console.log(
    `[shop] catalog loaded products=${cachedCatalog.productIds.length} marketIds=${marketToProductId.size} priceItems=${cachedCatalog.priceItemIds.length} suppressed=${suppressedProducts}`
  );
  return cachedCatalog;
}

function pickPreferredProductRecord(existing, incoming) {
  if (!existing) return incoming;
  return productRecordScore(incoming) > productRecordScore(existing) ? incoming : existing;
}

function productRecordScore(record) {
  if (!record) return 0;
  let score = 0;
  if (record.m_bEnabled === true) score += 4;
  if (record.m_bVisible === true) score += 2;
  if (!String(record.m_TabID || "").includes("NO_USE")) score += 1;
  return score;
}

function shouldSuppressShopProduct(record) {
  if (INCLUDE_BEGINNER_PACKS) return false;
  if (record && record.m_bUnlockBanner === true) return true;

  const searchableFields = [
    record && record.m_TabID,
    record && record.m_TabName,
    record && record.m_ItemName,
    record && record.m_Item_Desc,
    record && record.m_Item_Desc_Popup,
    record && record.m_TopBannerText,
    record && record.m_CardPrefab,
    ...(Array.isArray(record && record.listContentsTagAllow) ? record.listContentsTagAllow : []),
    ...(Array.isArray(record && record.listContentsTagIgnore) ? record.listContentsTagIgnore : []),
  ];

  const text = searchableFields.filter((value) => value != null).join(" ").toUpperCase();
  return text.includes("NEWBIE") || text.includes("BEGINNER") || text.includes("STARTER");
}

function findProductIdByMarketId(marketId) {
  if (!marketId) return 0;
  const catalog = loadShopCatalog();
  return catalog.marketToProductId.get(String(marketId)) || Number(marketId) || 0;
}

function findProductIdByPaymentId(paymentId) {
  const number = Number(paymentId);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function resolveProductId(productId) {
  const number = Number(productId);
  if (Number.isInteger(number) && number > 0) return number;
  return loadShopCatalog().productIds[0] || 0;
}

function findProductRecord(productId) {
  return loadShopCatalog().recordsByProductId.get(Number(productId)) || null;
}

function processProductPurchase(ctx, productId, productCount, options = {}) {
  const record = findProductRecord(productId);
  const user = getSessionUser(ctx);
  const source = options.source || "shop-buy";
  const shouldDedupe = options.dedupe !== false && (source === "steam" || source === "cash" || source === "gamebase");
  const purchaseKey = shouldDedupe ? getPurchaseKey(source, productId, options.request || {}) : "";
  if (shouldDedupe && hasCompletedPurchase(ctx.socket, purchaseKey)) return { reward: createEmptyReward(), costItem: null };
  const reward = record
    ? grantShopProduct(ctx, user, record, productCount)
    : grantFallbackResource(ctx, user, productCount);
  const costItem = record ? spendShopPrice(ctx, user, record, productCount) : null;
  trackShopPurchaseMission(ctx, user, record, productId, productCount, costItem);
  if (shouldDedupe) markCompletedPurchase(ctx.socket, purchaseKey);
  persistUserDb(ctx);
  return { reward, costItem };
}

function trackShopPurchaseMission(ctx, user, record, productId, productCount = 1, costItem = null) {
  if (!ctx || typeof ctx.trackMissionEvent !== "function") return;
  const count = Math.max(1, Number(productCount) || 1);
  const nowValue = ctx.dateTimeBinaryNow ? ctx.dateTimeBinaryNow() : undefined;
  let changed = false;
  const changedConditions = new Set();
  const track = (condition, amount, details) => {
    const tracked = ctx.trackMissionEvent(user, condition, amount, details);
    if (tracked) changedConditions.add(condition);
    changed = tracked || changed;
  };
  const details = { now: nowValue, shopId: Number(productId || (record && record.m_ProductID) || 0), value: Number(productId || 0) };
  track("SHOP_BUY", count, details);
  track("SHOP_BOUGHT", count, details);
  if (costItem && record) {
    const itemId = Number(record.m_PriceItemID || 0);
    const amount = Number(toBigInt(record.m_Price || 0, 0n) * BigInt(count));
    if (itemId > 0 && amount > 0) {
      track("USE_RESOURCE", amount, {
        now: nowValue,
        itemId,
        resourceId: itemId,
        value: itemId,
      });
    }
  }
  if (changed && typeof ctx.refreshMissionProgress === "function") {
    ctx.refreshMissionProgress(user, { now: nowValue, conditions: Array.from(changedConditions) });
  }
}

function grantFallbackReward(ctx, multiplier = 1) {
  const reward = grantFallbackResource(ctx, getSessionUser(ctx), multiplier);
  persistUserDb(ctx);
  return reward;
}

function getSessionUser(ctx) {
  return ctx && ctx.socket && ctx.socket.session ? ctx.socket.session.user : null;
}

function persistUserDb(ctx) {
  if (ctx && (!ctx.config || ctx.config.USE_LOCAL_USER_DB) && typeof ctx.saveUserDb === "function") ctx.saveUserDb();
}

function buildRewardData(ctx, reward) {
  const data = reward || createEmptyReward();
  const miscItems = Array.isArray(data.miscItems) ? data.miscItems : [];
  const skinIds = Array.isArray(data.skinIds) ? data.skinIds : [];
  const emoticonIds = Array.isArray(data.emoticonIds) ? data.emoticonIds : [];
  const units = Array.isArray(data.units) ? data.units : [];
  const operators = Array.isArray(data.operators) ? data.operators : [];
  const equips = Array.isArray(data.equips) ? data.equips : [];

  return Buffer.concat([
    ctx.writeSignedVarInt(0), // userExp
    ctx.writeSignedVarInt(0), // bonusRatioOfUserExp
    writeObjectList(units.map((unit) => writeNullableObject(buildUnitData(unit)))),
    writeObjectList(miscItems.map((item) => writeNullableObject(buildItemMiscData(ctx, item)))),
    writeObjectList(equips.map((equip) => writeNullableObject(buildEquipItemData(equip)))),
    writeObjectList([]), // unitExpDataList
    writeIntList(ctx, skinIds),
    writeObjectList([]), // moldItemDataList
    writeObjectList([]), // companyBuffDataList
    writeObjectList([]), // companyBuffDataList duplicate
    writeIntList(ctx, emoticonIds),
    ctx.writeSignedVarInt(0), // dailyMissionPoint
    ctx.writeSignedVarInt(0), // weeklyMissionPoint
    writeObjectList([]), // bingoTileList
    ctx.writeSignedVarLong(0n), // achievePoint
    writeObjectList(operators.map((operator) => writeNullableObject(buildOperatorData(operator)))),
    writeObjectList([]), // contractList
    writeObjectList([]), // interiors
  ]);
}

function buildItemMiscData(ctx, item) {
  return Buffer.concat([
    ctx.writeSignedVarInt(Number(item.itemId) || 0),
    ctx.writeSignedVarLong(toBigInt(item.countFree || 0)),
    ctx.writeSignedVarLong(toBigInt(item.countPaid || 0)),
    ctx.writeSignedVarInt(Number(item.bonusRatio || 0)),
    ctx.writeInt64LE(toBigInt(item.regDate || 0)),
  ]);
}

function buildPurchaseHistory(ctx, productId, productCount) {
  return Buffer.concat([
    ctx.writeSignedVarInt(Number(productId) || 0),
    ctx.writeSignedVarInt(0),
    ctx.writeSignedVarInt(0),
    ctx.writeSignedVarLong(0n),
  ]);
}

function formatShopRequest(request) {
  if (!request || typeof request !== "object") return "";
  const fields = [];
  for (const key of ["productID", "productId", "productMarketID", "slotIndex", "slotIndexes", "tabType", "subIndex", "paymentId", "couponCode"]) {
    if (request[key] == null) continue;
    const value = Array.isArray(request[key]) ? request[key].join(",") : request[key];
    fields.push(`${key}=${JSON.stringify(value)}`);
  }
  return fields.join(" ");
}

function writeString(value) {
  if (value == null) return writeSignedVarInt(-1);
  const bytes = Buffer.from(String(value), "utf8");
  return Buffer.concat([writeSignedVarInt(bytes.length), bytes]);
}

function writeIntList(ctx, values) {
  const list = Array.isArray(values) ? values : [];
  return Buffer.concat([writeVarInt(list.length), ...list.map((value) => ctx.writeSignedVarInt(Number(value) || 0))]);
}

function writeObjectList(values) {
  const list = Array.isArray(values) ? values : [];
  return Buffer.concat([writeVarInt(list.length), ...list]);
}

function writeObjectMapInt(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return Buffer.concat([
    writeVarInt(list.length),
    ...list.flatMap(([key, payload]) => [writeSignedVarInt(Number(key) || 0), writeNullableObject(payload)]),
  ]);
}

function writeNullableObject(payload) {
  return Buffer.concat([Buffer.from([1]), payload]);
}

function writeNullableObjectOrNull(payload) {
  return payload ? writeNullableObject(payload) : writeNullObject();
}

function writeNullObject() {
  return Buffer.from([0]);
}

function writeDoubleLE(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(Number(value) || 0, 0);
  return buffer;
}

function writeBool(value) {
  return Buffer.from([value ? 1 : 0]);
}

function writeSignedVarInt(value) {
  return writeVarInt(zigZagEncode32(value));
}

function writeSignedVarLong(value) {
  let current = zigZagEncode64(toBigInt(value || 0, 0n));
  const bytes = [];
  while (current > 0x7fn) {
    bytes.push(Number((current & 0x7fn) | 0x80n));
    current >>= 7n;
  }
  bytes.push(Number(current));
  return Buffer.from(bytes);
}

function writeVarInt(value) {
  let v = Number(value) >>> 0;
  const bytes = [];
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function readSignedVarInt(buffer, offset) {
  const raw = readVarInt(buffer, offset);
  return { value: zigZagDecode32(raw.value), offset: raw.offset };
}

function readVarInt(buffer, offset) {
  let result = 0;
  let shift = 0;
  while (shift < 32) {
    if (offset >= buffer.length) throw new Error("truncated varint");
    const byte = buffer.readUInt8(offset++);
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset };
    shift += 7;
  }
  throw new Error("varint too long");
}

function zigZagEncode32(value) {
  const v = Number(value) | 0;
  return ((v << 1) ^ (v >> 31)) >>> 0;
}

function zigZagDecode32(value) {
  return (value >>> 1) ^ -(value & 1);
}

function zigZagEncode64(value) {
  return (value << 1n) ^ (value >> 63n);
}

module.exports = {
  PACKETS,
  createShopHandler,
  loadShopCatalog,
  buildSerializedRandomShopData,
  ensureRandomShopState,
};
