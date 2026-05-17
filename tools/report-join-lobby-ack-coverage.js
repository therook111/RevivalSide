const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

const sourcePaths = {
  packetSchema: path.join(root, "packet-schema.json"),
  joinLobbyPacketCs: path.join(root, "Assembly-CSharp", "ClientPacket", "Account", "NKMPacket_JOIN_LOBBY_ACK.cs"),
  userDataCs: path.join(root, "Assembly-CSharp", "NKM", "NKMUserData.cs"),
  listener: path.join(root, "server", "listener.js"),
  managedBridge: path.join(root, "combat-host", "ManagedCombatBridge.cs"),
};

const statusOrder = ["local-owned", "local-stubbed", "captured-backed", "default-backed", "missing"];
const meaningfulConstantFields = new Set(["topLevel:errorCode", "topLevel:utcOffset", "userData:m_eAuthLevel"]);

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function relativePath(filePath) {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function countNewlines(text) {
  const matches = text.match(/\n/g);
  return matches ? matches.length : 0;
}

function lineNumberAt(source, index) {
  return countNewlines(source.slice(0, index)) + 1;
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeType(type) {
  return normalizeWhitespace(type)
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*<\s*/g, "<")
    .replace(/\s*>\s*/g, ">")
    .replace(/\bglobal::/g, "");
}

function stripComments(source) {
  let result = "";
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (ch === "\n") {
        lineComment = false;
        result += ch;
      }
      continue;
    }

    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        index += 1;
        continue;
      }
      if (ch === "\n") result += ch;
      continue;
    }

    if (quote) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
    }
    result += ch;
  }

  return result;
}

function findMatching(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const ch = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === openChar) {
      depth += 1;
    } else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function findFunctionBody(source, functionName) {
  const pattern = new RegExp(`\\bfunction\\s+${functionName}\\s*\\(`);
  const match = pattern.exec(source);
  if (!match) throw new Error(`Could not find function ${functionName}`);
  const open = source.indexOf("{", match.index + match[0].length);
  const close = findMatching(source, open, "{", "}");
  if (open < 0 || close < 0) throw new Error(`Could not parse function ${functionName}`);
  return {
    body: source.slice(open + 1, close),
    offset: open + 1,
  };
}

function splitTopLevelArrayItems(source) {
  const items = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  function pushItem(end) {
    const raw = source.slice(start, end);
    if (stripComments(raw).trim()) {
      items.push({ raw, start });
    }
    start = end + 1;
  }

  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth -= 1;
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth -= 1;
    else if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth -= 1;
    else if (ch === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      pushItem(index);
    }
  }

  pushItem(source.length);
  return items;
}

function extractBufferConcatItems(source, functionName) {
  const fn = findFunctionBody(source, functionName);
  const marker = "return Buffer.concat(";
  const markerIndex = fn.body.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Could not find Buffer.concat return in ${functionName}`);
  const openParen = fn.body.indexOf("(", markerIndex);
  const openArray = fn.body.indexOf("[", openParen);
  const closeArray = findMatching(fn.body, openArray, "[", "]");
  if (openArray < 0 || closeArray < 0) throw new Error(`Could not parse Buffer.concat array in ${functionName}`);

  const arraySource = fn.body.slice(openArray + 1, closeArray);
  const arrayOffset = fn.offset + openArray + 1;
  return splitTopLevelArrayItems(arraySource).map((item, index) => ({
    order: index + 1,
    line: lineNumberAt(source, arrayOffset + item.start),
    expression: normalizeWhitespace(stripComments(item.raw)),
  }));
}

function extractStringArray(source, arrayName) {
  const pattern = new RegExp(`\\b${arrayName}\\s*=\\s*\\[`);
  const match = pattern.exec(source);
  if (!match) throw new Error(`Could not find ${arrayName}`);
  const openArray = source.indexOf("[", match.index);
  const closeArray = findMatching(source, openArray, "[", "]");
  if (openArray < 0 || closeArray < 0) throw new Error(`Could not parse ${arrayName}`);
  const body = source.slice(openArray + 1, closeArray);
  const values = [];
  for (const item of body.matchAll(/"([^"]+)"/g)) values.push(item[1]);
  return values;
}

function extractCSharpFieldDeclarations(source) {
  const cleanSource = stripComments(source);
  const declarations = {};
  const fieldPattern =
    /\b(?:public|private|protected|internal)\s+(?:static\s+)?(?:readonly\s+)?([A-Za-z0-9_<>,.\[\]\s]+?)\s+([A-Za-z0-9_]+)\s*(?:=\s*([^;]+))?;/g;

  for (const match of cleanSource.matchAll(fieldPattern)) {
    declarations[match[2]] = {
      declaredType: normalizeType(match[1]),
      initializer: match[3] ? normalizeWhitespace(match[3]) : null,
      hasInitializer: Boolean(match[3]),
    };
  }

  return declarations;
}

function extractCSharpSerializeFields(source, methodPattern) {
  const methodMatch = methodPattern.exec(source);
  if (!methodMatch) throw new Error("Could not find C# Serialize method");
  const open = source.indexOf("{", methodMatch.index + methodMatch[0].length);
  const close = findMatching(source, open, "{", "}");
  if (open < 0 || close < 0) throw new Error("Could not parse C# Serialize method");

  const declarations = extractCSharpFieldDeclarations(source);
  const body = source.slice(open + 1, close);
  const bodyOffset = open + 1;
  const fields = [];
  const callPattern = /stream\.(PutOrGetEnum|PutOrGet|AsHalf)(?:<([^>\r\n]+)>)?\s*\(\s*ref\s+this\.([A-Za-z0-9_]+)\s*\)/g;

  for (const match of body.matchAll(callPattern)) {
    const name = match[3];
    fields.push({
      name,
      order: fields.length + 1,
      line: lineNumberAt(source, bodyOffset + match.index),
      call: match[1],
      genericType: match[2] ? normalizeType(match[2]) : null,
      declaredType: declarations[name] ? declarations[name].declaredType : match[2] ? normalizeType(match[2]) : "unknown",
      initializer: declarations[name] ? declarations[name].initializer : null,
      hasInitializer: declarations[name] ? declarations[name].hasInitializer : false,
    });
  }

  return fields;
}

function loadJoinLobbySchema() {
  const schema = JSON.parse(readText(sourcePaths.packetSchema));
  const packet =
    schema.packets &&
    (schema.packets.NKMPacket_JOIN_LOBBY_ACK ||
      Object.values(schema.packets).find((entry) => entry && entry.name === "NKMPacket_JOIN_LOBBY_ACK"));
  if (!packet) throw new Error("packet-schema.json does not contain NKMPacket_JOIN_LOBBY_ACK");
  return packet.fields.map((field, index) => ({
    name: field.name,
    order: index + 1,
    declaredType: field.declaredType,
    wire: field.wire,
  }));
}

function mapByName(items) {
  const map = new Map();
  for (const item of items) map.set(item.name, item);
  return map;
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return Array.from(duplicates).sort();
}

function isNkmIntervalField(field) {
  if (!field) return false;
  if (field.name === "intervalData") return true;
  const typeText = `${field.declaredType || ""} ${JSON.stringify(field.wire || {})}`;
  return /\bNKMIntervalData\b/.test(typeText);
}

function isStubExpression(entity, fieldName, expression) {
  if (!expression) return false;
  if (meaningfulConstantFields.has(`${entity}:${fieldName}`)) return false;

  const expr = normalizeWhitespace(expression);
  const dynamicPatterns = [
    /\buser\b/,
    /\buserUid\b/,
    /\bfriendCode\b/,
    /\bnickname\b/,
    /\bnow\b/,
    /\blobbyNow\b/,
    /\bstamina\./,
    /\bcollection\./,
    /\bsimulation\./,
    /\blobbyCustomization\./,
    /\bbuildMinimal(?:UserData|InventoryData|ArmyData|UserOption|ShopData|MissionData)\b/,
    /\bbuild(?:DungeonClearEntries|EpisodeCompleteEntries|StagePlayDataList|PhaseClearDataList)\b/,
    /\bbuild(?:AttendanceData|BackgroundInfoData|JukeboxData|UserProfileData|SupportUnitData)\b/,
    /\bbuildSerialized[A-Za-z0-9_]*\b/,
    /\bget(?:All|Join|Army|Misc|Skin|Completed|MainStory|Story|Event|Player|Shop|Content|Reward)[A-Za-z0-9_]*\b/,
  ];
  if (dynamicPatterns.some((pattern) => pattern.test(expr))) return false;

  const stubPatterns = [
    /^writeNullObject\(\)$/,
    /^writeObjectList\(\s*\[\s*\]\s*\)$/,
    /^writeIntList\(\s*\[\s*\]\s*\)$/,
    /^writeObjectMap(?:Int|Long)\(\s*\[\s*\]\s*\)$/,
    /^writeBool\(\s*false\s*\)$/,
    /^writeString\(\s*(?:""|'')\s*\)$/,
    /^write(?:SignedVarInt|VarInt|Byte)\(\s*0\s*\)$/,
    /^writeSignedVarLong\(\s*0n?\s*\)$/,
    /^writeInt64LE\(\s*0n?\s*\)$/,
    /^writeDoubleLE\(\s*0\s*\)$/,
    /^writeNullableObject\(\s*build[A-Za-z0-9_]+\(\s*\)\s*\)$/,
    /^build[A-Za-z0-9_]+\(\s*\)$/,
    /^Buffer\.concat\(\s*Array\.from\(\s*\{[^}]*\}\s*,\s*\(\)\s*=>\s*writeSignedVarInt\(\s*0\s*\)\s*\)\s*\)$/,
  ];
  if (stubPatterns.some((pattern) => pattern.test(expr))) return true;

  return false;
}

function localExpressionKind(entity, fieldName, listenerItem) {
  if (!listenerItem) return "missing";
  return isStubExpression(entity, fieldName, listenerItem.expression) ? "stub" : "local-data";
}

function classifyField({ entity, fieldName, bridgeOwned, listenerItem, sourceMissing }) {
  if (sourceMissing || !listenerItem) return "missing";
  if (bridgeOwned) {
    return localExpressionKind(entity, fieldName, listenerItem) === "stub" ? "local-stubbed" : "local-owned";
  }
  return "captured-backed";
}

function classifyNormalizedField({ entity, fieldName, bridgeOwned, listenerItem, sourceMissing }) {
  if (sourceMissing || !listenerItem) return "missing";
  if (bridgeOwned) {
    return localExpressionKind(entity, fieldName, listenerItem) === "stub" ? "local-stubbed" : "local-owned";
  }
  return "default-backed";
}

function compareOrderedNames(label, expected, actual, mismatches) {
  if (expected.length !== actual.length) {
    mismatches.push({
      scope: label,
      kind: "count-mismatch",
      expected: expected.length,
      actual: actual.length,
    });
  }
  const max = Math.max(expected.length, actual.length);
  for (let index = 0; index < max; index += 1) {
    if (expected[index] !== actual[index]) {
      mismatches.push({
        scope: label,
        kind: "order-or-name-mismatch",
        order: index + 1,
        expected: expected[index] || null,
        actual: actual[index] || null,
      });
    }
  }
}

function buildEntries({
  entity,
  expectedFields,
  csharpFields,
  listenerItems,
  bridgeOwnedFields,
  schemaFields = null,
  excludedPredicate = () => false,
  mismatches,
}) {
  const csharpByName = mapByName(csharpFields);
  const schemaByName = schemaFields ? mapByName(schemaFields) : new Map();
  const bridgeOwned = new Set(bridgeOwnedFields);
  const entries = [];
  const excluded = [];

  for (const field of expectedFields) {
    const csharpField = csharpByName.get(field.name);
    const schemaField = schemaFields ? schemaByName.get(field.name) : null;
    const listenerIndex = csharpField ? csharpField.order - 1 : field.order - 1;
    const listenerItem = listenerItems[listenerIndex] || null;
    const sourceMissing = Boolean(schemaFields && !schemaField) || !csharpField || !listenerItem;
    const bridgeHasField = bridgeOwned.has(field.name);
    const localKind = localExpressionKind(entity, field.name, listenerItem);
    const status = classifyField({
      entity,
      fieldName: field.name,
      bridgeOwned: bridgeHasField,
      listenerItem,
      sourceMissing,
    });
    const normalizedStatus = classifyNormalizedField({
      entity,
      fieldName: field.name,
      bridgeOwned: bridgeHasField,
      listenerItem,
      sourceMissing,
    });

    const entry = {
      order: field.order,
      name: field.name,
      declaredType: (schemaField && schemaField.declaredType) || (csharpField && csharpField.declaredType) || field.declaredType || "unknown",
      status,
      normalizedStatus,
      localSerializationKind: localKind,
      schema: schemaFields
        ? {
            present: Boolean(schemaField),
            order: schemaField ? schemaField.order : null,
            wire: schemaField ? schemaField.wire : null,
          }
        : null,
      assemblySerialization: {
        present: Boolean(csharpField),
        order: csharpField ? csharpField.order : null,
        line: csharpField ? csharpField.line : null,
        call: csharpField ? csharpField.call : null,
        initializer: csharpField ? csharpField.initializer : null,
      },
      listenerSerialization: {
        present: Boolean(listenerItem),
        order: listenerItem ? listenerItem.order : null,
        line: listenerItem ? listenerItem.line : null,
        expression: listenerItem ? listenerItem.expression : null,
      },
      managedBridgeMerge: {
        localField: bridgeHasField,
      },
    };

    if (excludedPredicate(field)) {
      excluded.push({
        order: entry.order,
        name: entry.name,
        declaredType: entry.declaredType,
        reason: "NKMIntervalData is intentionally excluded",
      });
    } else {
      entries.push(entry);
    }
  }

  for (const fieldName of bridgeOwnedFields) {
    if (!expectedFields.some((field) => field.name === fieldName)) {
      mismatches.push({
        scope: entity,
        kind: "bridge-field-not-serialized",
        field: fieldName,
      });
    }
  }

  return { entries, excluded };
}

function summarize(entries) {
  const counts = Object.fromEntries(statusOrder.map((status) => [status, 0]));
  for (const entry of entries) counts[entry.status] = (counts[entry.status] || 0) + 1;
  const total = entries.length;
  const percentages = {};
  for (const status of statusOrder) {
    percentages[status] = total ? Number(((counts[status] / total) * 100).toFixed(1)) : 0;
  }
  return { total, counts, percentages };
}

function summarizeNormalized(entries) {
  const counts = Object.fromEntries(statusOrder.map((status) => [status, 0]));
  for (const entry of entries) counts[entry.normalizedStatus] = (counts[entry.normalizedStatus] || 0) + 1;
  const total = entries.length;
  const percentages = {};
  for (const status of statusOrder) {
    percentages[status] = total ? Number(((counts[status] / total) * 100).toFixed(1)) : 0;
  }
  return { total, counts, percentages };
}

function formatSummaryLine(label, summary) {
  return `${label}: ${summary.total} fields; ${statusOrder
    .map((status) => `${status} ${summary.counts[status]} (${summary.percentages[status]}%)`)
    .join(", ")}`;
}

function main() {
  const schemaFields = loadJoinLobbySchema();
  const joinLobbyPacketCs = readText(sourcePaths.joinLobbyPacketCs);
  const userDataCs = readText(sourcePaths.userDataCs);
  const listener = readText(sourcePaths.listener);
  const managedBridge = readText(sourcePaths.managedBridge);

  const packetCsharpFields = extractCSharpSerializeFields(
    joinLobbyPacketCs,
    /void\s+ISerializable\.Serialize\s*\(\s*IPacketStream\s+stream\s*\)/
  );
  const userDataCsharpFields = extractCSharpSerializeFields(userDataCs, /public\s+void\s+Serialize\s*\(\s*IPacketStream\s+stream\s*\)/);
  const topLevelListenerItems = extractBufferConcatItems(listener, "buildMinimalJoinLobbyPayload");
  const userDataListenerItems = extractBufferConcatItems(listener, "buildMinimalUserData");
  const localJoinLobbyFields = extractStringArray(managedBridge, "LocalJoinLobbyFields");
  const localJoinLobbyUserDataFields = extractStringArray(managedBridge, "LocalJoinLobbyUserDataFields");

  const mismatches = [];
  compareOrderedNames(
    "JOIN_LOBBY_ACK schema vs Assembly-CSharp serialization",
    schemaFields.map((field) => field.name),
    packetCsharpFields.map((field) => field.name),
    mismatches
  );
  compareOrderedNames(
    "JOIN_LOBBY_ACK Assembly-CSharp serialization vs server/listener.js buildMinimalJoinLobbyPayload",
    packetCsharpFields.map((field) => field.name),
    topLevelListenerItems.map((_, index) => packetCsharpFields[index] && packetCsharpFields[index].name),
    mismatches
  );
  compareOrderedNames(
    "NKMUserData Assembly-CSharp serialization vs server/listener.js buildMinimalUserData",
    userDataCsharpFields.map((field) => field.name),
    userDataListenerItems.map((_, index) => userDataCsharpFields[index] && userDataCsharpFields[index].name),
    mismatches
  );

  for (const duplicate of findDuplicates(localJoinLobbyFields)) {
    mismatches.push({ scope: "topLevel", kind: "duplicate-bridge-field", field: duplicate });
  }
  for (const duplicate of findDuplicates(localJoinLobbyUserDataFields)) {
    mismatches.push({ scope: "userData", kind: "duplicate-bridge-field", field: duplicate });
  }

  const topLevel = buildEntries({
    entity: "topLevel",
    expectedFields: schemaFields,
    csharpFields: packetCsharpFields,
    listenerItems: topLevelListenerItems,
    bridgeOwnedFields: localJoinLobbyFields,
    schemaFields,
    excludedPredicate: isNkmIntervalField,
    mismatches,
  });

  const userData = buildEntries({
    entity: "userData",
    expectedFields: userDataCsharpFields,
    csharpFields: userDataCsharpFields,
    listenerItems: userDataListenerItems,
    bridgeOwnedFields: localJoinLobbyUserDataFields,
    mismatches,
  });

  const allEntries = [...topLevel.entries, ...userData.entries];
  const report = {
    generatedAt: new Date().toISOString(),
    packet: "ClientPacket.Account.NKMPacket_JOIN_LOBBY_ACK",
    packetId: 205,
    statusDefinitions: {
      "local-owned": "The bridge copies the field from the local JOIN_LOBBY_ACK payload and the local expression is not recognized as a stub.",
      "local-stubbed": "The bridge copies the field from the local payload, but the local expression is a static/null/empty placeholder.",
      "captured-backed": "The field is serialized by the client but is not locally copied by the bridge, so captured ACK data remains authoritative in merge mode.",
      "default-backed": "The field is serialized by the client but is not locally copied by the bridge, so the normalized no-captured path keeps the managed default.",
      missing: "The field is absent or out of sync across schema, Assembly-CSharp serialization, or the listener payload builder.",
    },
    sources: Object.fromEntries(Object.entries(sourcePaths).map(([key, filePath]) => [key, relativePath(filePath)])),
    excluded: topLevel.excluded,
    summary: {
      primaryMerge: {
        overall: summarize(allEntries),
        topLevel: summarize(topLevel.entries),
        userData: summarize(userData.entries),
      },
      normalizedNoCapturedPath: {
        overall: summarizeNormalized(allEntries),
        topLevel: summarizeNormalized(topLevel.entries),
        userData: summarizeNormalized(userData.entries),
      },
      mismatches: mismatches.length,
    },
    mismatches,
    topLevelFields: topLevel.entries,
    userDataFields: userData.entries,
  };

  const primary = report.summary.primaryMerge.overall;
  const normalized = report.summary.normalizedNoCapturedPath.overall;
  console.error(
    `JOIN_LOBBY_ACK coverage: ${primary.total} reported fields (${topLevel.entries.length} top-level, ${userData.entries.length} NKMUserData; ${topLevel.excluded.length} excluded NKMIntervalData field).`
  );
  console.error(formatSummaryLine("primary merge", primary));
  console.error(formatSummaryLine("normalized no-captured", normalized));
  if (mismatches.length) console.error(`mismatches: ${mismatches.length}`);

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  }
}
