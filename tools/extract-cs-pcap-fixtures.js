const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const HEAD_FENCE = 0xaabbccdd;
const TAIL_FENCE = 0x11223344;
const TSHARK_PATH = process.env.CS_TSHARK_PATH || "C:\\Program Files\\Wireshark\\tshark.exe";
const KNOWN_GAME_SERVER_PORTS = new Set(["20001", "20002", "20003", "20004", "22000"]);

function usage() {
  console.error(
    "usage: node tools/extract-cs-pcap-fixtures.js <pcap> <outDir> <tcp|game> <stream> [clientHost]\n" +
      "  tcp:  writes captured-tcp manifest entries for server packets\n" +
      "  game: writes captured-game-flow manifest for client/server packets"
  );
  process.exit(2);
}

const [pcap, outDir, mode, streamArg, clientHostArg] = process.argv.slice(2);
if (!pcap || !outDir || !mode || !streamArg) usage();
const stream = Number(streamArg);
if (!Number.isFinite(stream)) usage();

const clientHost = clientHostArg || "";
const rows = readStreamRows(pcap, stream);
if (rows.length === 0) throw new Error(`no tcp payload rows for stream ${stream}`);

let endpoints = inferEndpoints(rows, clientHost);
let flow = buildPacketFlow(rows, endpoints);
if (mode === "game") {
  const reversed = buildPacketFlow(rows, { client: endpoints.server, server: endpoints.client });
  if (shouldPreferFlow(reversed, flow)) {
    endpoints = { client: endpoints.server, server: endpoints.client };
    flow = reversed;
  }
}

fs.mkdirSync(outDir, { recursive: true });

if (mode === "tcp") {
  writeTcpFixtures(outDir, pcap, stream, flow.serverPackets);
} else if (mode === "game") {
  writeGameFixtures(outDir, pcap, stream, flow.clientPackets, flow.serverPackets);
} else {
  usage();
}

console.log(
  `[extract] mode=${mode} stream=${stream} client=${endpoints.client} server=${endpoints.server} clientPackets=${flow.clientPackets.length} serverPackets=${flow.serverPackets.length} out=${outDir}`
);

function readStreamRows(file, tcpStream) {
  const output = execFileSync(
    TSHARK_PATH,
    [
      "-r",
      file,
      "-Y",
      `tcp.stream == ${tcpStream} && tcp.len > 0`,
      "-T",
      "fields",
      "-E",
      "separator=\t",
      "-e",
      "frame.number",
      "-e",
      "frame.time_relative",
      "-e",
      "ip.src",
      "-e",
      "ipv6.src",
      "-e",
      "tcp.srcport",
      "-e",
      "ip.dst",
      "-e",
      "ipv6.dst",
      "-e",
      "tcp.dstport",
      "-e",
      "tcp.payload",
    ],
    { encoding: "utf8" }
  );

  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [frame, time, ipSrc, ipv6Src, srcPort, ipDst, ipv6Dst, dstPort, payloadHex] = line.split("\t");
      const src = ipSrc || ipv6Src || "";
      const dst = ipDst || ipv6Dst || "";
      return {
        frame: Number(frame),
        time: Number(time),
        src: `${src}:${srcPort}`,
        dst: `${dst}:${dstPort}`,
        payload: Buffer.from((payloadHex || "").replace(/:/g, ""), "hex"),
      };
    })
    .filter((row) => row.payload.length > 0)
    .sort((a, b) => a.frame - b.frame);
}

function inferEndpoints(rows, preferredClientHost) {
  const totals = new Map();
  for (const row of rows) {
    totals.set(row.src, (totals.get(row.src) || 0) + row.payload.length);
  }
  const endpoints = [...totals.keys()];
  if (endpoints.length !== 2) throw new Error(`expected 2 endpoints, got ${endpoints.length}`);

  const preferred = endpoints.find((endpoint) => preferredClientHost && endpoint.startsWith(`${preferredClientHost}:`));
  if (preferred) {
    return { client: preferred, server: endpoints.find((endpoint) => endpoint !== preferred) };
  }

  const knownServer = endpoints.find((endpoint) => KNOWN_GAME_SERVER_PORTS.has(endpointPort(endpoint)));
  if (knownServer) return { client: endpoints.find((endpoint) => endpoint !== knownServer), server: knownServer };

  const localEndpoints = endpoints.filter((endpoint) => isLocalHost(endpointHost(endpoint)));
  if (localEndpoints.length === 1) return { client: localEndpoints[0], server: endpoints.find((endpoint) => endpoint !== localEndpoints[0]) };

  const sortedByPort = endpoints.slice().sort((left, right) => endpointPortNumber(right) - endpointPortNumber(left));
  return { client: sortedByPort[0], server: sortedByPort[1] };
}

function buildPacketFlow(rows, endpoints) {
  const clientSegments = buildSegments(rows.filter((row) => row.src === endpoints.client));
  const serverSegments = buildSegments(rows.filter((row) => row.src === endpoints.server));
  const clientBytes = Buffer.concat(clientSegments.map((row) => row.payload));
  const serverBytes = Buffer.concat(serverSegments.map((row) => row.payload));
  return {
    clientPackets: parsePackets(clientBytes, clientSegments),
    serverPackets: parsePackets(serverBytes, serverSegments),
  };
}

function shouldPreferFlow(candidate, current) {
  const candidateJoinLobby = countPackets(candidate.serverPackets, 205);
  const currentJoinLobby = countPackets(current.serverPackets, 205);
  if (candidateJoinLobby !== currentJoinLobby) return candidateJoinLobby > currentJoinLobby;
  return scoreServerPackets(candidate.serverPackets) > scoreServerPackets(current.serverPackets);
}

function countPackets(packets, packetId) {
  return packets.filter((packet) => packet.packetId === packetId).length;
}

function scoreServerPackets(packets) {
  return packets.reduce((score, packet) => {
    if (packet.packetId === 205) return score + 1000;
    if (packet.packetId > 0 && packet.packetId % 2 === 1) return score + 1;
    return score;
  }, 0);
}

function endpointPort(endpoint) {
  const text = String(endpoint || "");
  const index = text.lastIndexOf(":");
  return index >= 0 ? text.slice(index + 1) : "";
}

function endpointPortNumber(endpoint) {
  const port = Number(endpointPort(endpoint));
  return Number.isInteger(port) ? port : 0;
}

function endpointHost(endpoint) {
  const text = String(endpoint || "");
  const index = text.lastIndexOf(":");
  return index >= 0 ? text.slice(0, index) : text;
}

function isLocalHost(host) {
  const text = String(host || "").toLowerCase();
  if (!text) return false;
  if (text === "::1" || text === "localhost") return true;
  if (text.startsWith("127.")) return true;
  if (text.startsWith("10.")) return true;
  if (text.startsWith("192.168.")) return true;
  const ipv4 = text.match(/^172\.(\d+)\./);
  if (ipv4 && Number(ipv4[1]) >= 16 && Number(ipv4[1]) <= 31) return true;
  return text.startsWith("fc") || text.startsWith("fd") || text.startsWith("fe80:");
}

function buildSegments(rows) {
  let offset = 0;
  return rows.map((row) => {
    const segment = {
      ...row,
      startOffset: offset,
      endOffset: offset + row.payload.length,
    };
    offset = segment.endOffset;
    return segment;
  });
}

function parsePackets(buffer, segments) {
  const packets = [];
  let offset = 0;
  while (offset + 12 <= buffer.length) {
    const fence = buffer.indexOf(Buffer.from([0xdd, 0xcc, 0xbb, 0xaa]), offset);
    if (fence < 0) break;
    if (fence + 12 > buffer.length) break;
    const totalLength = buffer.readInt32LE(fence + 4);
    if (totalLength <= 12 || fence + totalLength > buffer.length) {
      offset = fence + 1;
      continue;
    }
    const raw = buffer.subarray(fence, fence + totalLength);
    const tail = raw.readUInt32LE(totalLength - 4);
    if (tail !== TAIL_FENCE) {
      offset = fence + 1;
      continue;
    }
    packets.push(parsePacket(raw, findSegment(segments, fence)));
    offset = fence + totalLength;
  }
  return packets;
}

function findSegment(segments, offset) {
  return segments.find((segment) => offset >= segment.startOffset && offset < segment.endOffset) || null;
}

function parsePacket(raw, segment) {
  if (raw.readUInt32LE(0) !== HEAD_FENCE) throw new Error("invalid head fence");
  const totalLength = raw.readInt32LE(4);
  let offset = 8;
  const sequenceRaw = readVarLong(raw, offset);
  offset = sequenceRaw.offset;
  const packetIdRaw = readVarInt(raw, offset);
  offset = packetIdRaw.offset;
  const compressed = raw.readUInt8(offset) !== 0;
  offset += 1;
  const payloadSizeRaw = readSignedVarInt(raw, offset);
  offset = payloadSizeRaw.offset;
  const payloadStart = offset;
  const payloadEnd = payloadStart + payloadSizeRaw.value;
  return {
    raw,
    totalLength,
    sequence: zigZagDecode64(sequenceRaw.value).toString(),
    packetId: packetIdRaw.value,
    compressed,
    payloadSize: payloadSizeRaw.value,
    payload: raw.subarray(payloadStart, payloadEnd),
    tail: raw.readUInt32LE(totalLength - 4),
    frame: segment ? segment.frame : 0,
    time: segment ? segment.time : 0,
  };
}

function writeTcpFixtures(dir, sourcePcap, tcpStream, packets) {
  const manifest = {};
  for (const packet of packets) {
    const key = String(packet.packetId);
    if (packet.packetId !== 203 && packet.packetId !== 217) continue;
    const rawFile = `${key}.packet.bin`;
    const payloadFile = `${key}.payload.bin`;
    fs.writeFileSync(path.join(dir, rawFile), packet.raw);
    fs.writeFileSync(path.join(dir, payloadFile), packet.payload);
    manifest[key] = packetManifest(packet, sourcePcap, tcpStream, rawFile, payloadFile);
  }
  const existingPath = path.join(dir, "manifest.json");
  const existing = fs.existsSync(existingPath) ? JSON.parse(fs.readFileSync(existingPath, "utf8")) : {};
  fs.writeFileSync(existingPath, JSON.stringify({ ...existing, ...manifest }, null, 2));
}

function writeGameFixtures(dir, sourcePcap, tcpStream, clients, servers) {
  cleanOldFlow(dir);
  const manifest = { sourcePcap, stream: tcpStream, client: [], server: [] };
  for (let index = 0; index < clients.length; index += 1) {
    manifest.client.push(writeFlowPacket(dir, "client", index + 1, clients[index], sourcePcap, tcpStream));
  }
  for (let index = 0; index < servers.length; index += 1) {
    manifest.server.push(writeFlowPacket(dir, "server", index + 1, servers[index], sourcePcap, tcpStream));
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function cleanOldFlow(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(dir)) {
    if (/^(client|server)_\d+_\d+\.(packet|payload)\.bin$/.test(file) || file === "manifest.json") {
      fs.unlinkSync(path.join(dir, file));
    }
  }
}

function writeFlowPacket(dir, side, index, packet, sourcePcap, tcpStream) {
  const prefix = `${side}_${String(index).padStart(3, "0")}_${packet.packetId}`;
  const rawFile = `${prefix}.packet.bin`;
  const payloadFile = `${prefix}.payload.bin`;
  fs.writeFileSync(path.join(dir, rawFile), packet.raw);
  fs.writeFileSync(path.join(dir, payloadFile), packet.payload);
  return {
    seq: Number(packet.sequence),
    packetId: packet.packetId,
    compressed: packet.compressed,
    payloadSize: packet.payloadSize,
    totalLength: packet.totalLength,
    rawFile,
    payloadFile,
    sourcePcap,
    stream: tcpStream,
    frame: packet.frame,
    time: packet.time,
    sha256: sha256(packet.raw),
  };
}

function packetManifest(packet, sourcePcap, tcpStream, rawFile, payloadFile) {
  return {
    packetId: packet.packetId,
    stream: tcpStream,
    sequence: Number(packet.sequence),
    compressed: packet.compressed,
    payloadSize: packet.payloadSize,
    payloadFile,
    rawFile,
    totalLength: packet.totalLength,
    tail: packet.tail,
    sourcePcap,
    frame: packet.frame,
    time: packet.time,
    sha256: sha256(packet.raw),
  };
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readVarInt(buffer, offset) {
  let result = 0;
  let shift = 0;
  let current = offset;
  while (current < buffer.length) {
    const byte = buffer[current++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset: current };
    shift += 7;
  }
  throw new Error("unterminated varint");
}

function readVarLong(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  let current = offset;
  while (current < buffer.length) {
    const byte = BigInt(buffer[current++]);
    result |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return { value: result, offset: current };
    shift += 7n;
  }
  throw new Error("unterminated varlong");
}

function readSignedVarInt(buffer, offset) {
  const raw = readVarInt(buffer, offset);
  return { value: zigZagDecode32(raw.value), offset: raw.offset };
}

function zigZagDecode32(value) {
  return (value >>> 1) ^ -(value & 1);
}

function zigZagDecode64(value) {
  return (value >> 1n) ^ -(value & 1n);
}
