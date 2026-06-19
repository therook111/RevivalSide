package dev.revivalside.capture.android

import android.content.Context
import dev.revivalside.capture.protocol.CapturedCounterSideFrame
import dev.revivalside.capture.protocol.toLowerHex
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

internal object CaptureRepository {
    private const val PREFS = "revivalside_capture"
    private const val KEY_LATEST_EXPORT = "latest_export"
    private val stampFormat = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneOffset.UTC)

    @Synchronized
    fun saveJoinLobbyAck(context: Context, frame: CapturedCounterSideFrame, connectionLabel: String): File {
        val exportDir = File(context.filesDir, "exports")
        exportDir.mkdirs()
        val stamp = stampFormat.format(Instant.now())
        val zipFile = File(exportDir, "join-lobby-ack-$stamp.zip")
        val rawName = "server_001_${frame.packetId}.packet.bin"
        val payloadName = "server_001_${frame.packetId}.payload.bin"
        val manifest = buildManifest(frame, connectionLabel, rawName, payloadName)

        ZipOutputStream(zipFile.outputStream().buffered()).use { zip ->
            zip.putNextEntry(ZipEntry("manifest.json"))
            zip.write(manifest.toByteArray(Charsets.UTF_8))
            zip.closeEntry()

            zip.putNextEntry(ZipEntry(rawName))
            zip.write(frame.raw)
            zip.closeEntry()

            zip.putNextEntry(ZipEntry(payloadName))
            zip.write(frame.payload)
            zip.closeEntry()
        }

        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_LATEST_EXPORT, zipFile.absolutePath)
            .apply()
        return zipFile
    }

    @Synchronized
    fun saveOfficialLoginPackets(
        context: Context,
        frames: Collection<CapturedCounterSideFrame>,
        connectionLabel: String,
    ): File {
        val selected = frames
            .filter { it.packetId == LOGIN_ACK || it.packetId == GAMEBASE_LOGIN_ACK || it.packetId == CONTENTS_VERSION_ACK }
            .distinctBy { it.packetId }
            .sortedBy { it.sequence }
        require(selected.isNotEmpty()) { "No official login packets were captured." }

        val exportDir = File(context.filesDir, "exports")
        exportDir.mkdirs()
        val stamp = stampFormat.format(Instant.now())
        val zipFile = File(exportDir, "official-login-packets-$stamp.zip")
        val manifest = buildCapturedTcpManifest(selected, connectionLabel)

        ZipOutputStream(zipFile.outputStream().buffered()).use { zip ->
            zip.putNextEntry(ZipEntry("manifest.json"))
            zip.write(manifest.toByteArray(Charsets.UTF_8))
            zip.closeEntry()

            for (frame in selected) {
                zip.putNextEntry(ZipEntry("${frame.packetId}.packet.bin"))
                zip.write(frame.raw)
                zip.closeEntry()

                zip.putNextEntry(ZipEntry("${frame.packetId}.payload.bin"))
                zip.write(frame.payload)
                zip.closeEntry()
            }
        }

        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_LATEST_EXPORT, zipFile.absolutePath)
            .apply()
        return zipFile
    }

    fun latestExport(context: Context): File? {
        val path = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_LATEST_EXPORT, "") ?: ""
        val file = File(path)
        return file.takeIf { path.isNotBlank() && it.isFile }
    }

    @Synchronized
    fun extractLatestJoinLobbyAckToCapturedGameFlow(context: Context): ExtractedJoinLobbyAck {
        val export = latestExport(context)
            ?: throw IllegalStateException("No JOIN_LOBBY_ACK export is available yet.")
        if (!export.isFile) throw IllegalStateException("Latest export is missing: ${export.absolutePath}")

        val targetDir = File(RevivalSideSettingsStore.serverDataDir(context), "captured-game-flow")
        targetDir.mkdirs()

        ZipFile(export).use { zip ->
            val manifestEntry = zip.getEntry("manifest.json")
                ?: throw IllegalStateException("Capture bundle is missing manifest.json.")
            val manifestText = zip.getInputStream(manifestEntry).bufferedReader(Charsets.UTF_8).use { it.readText() }
            if (!Regex("\"packetId\"\\s*:\\s*$JOIN_LOBBY_ACK").containsMatchIn(manifestText)) {
                throw IllegalStateException("Latest export is not a JOIN_LOBBY_ACK bundle.")
            }

            var copiedFiles = 0
            var copiedBytes = 0L
            val entries = zip.entries()
            while (entries.hasMoreElements()) {
                val entry = entries.nextElement()
                if (entry.isDirectory) continue
                val destination = safeZipDestination(targetDir, entry.name) ?: continue
                destination.parentFile?.mkdirs()
                zip.getInputStream(entry).use { input ->
                    destination.outputStream().use { output ->
                        copiedBytes += input.copyTo(output)
                    }
                }
                copiedFiles += 1
            }
            if (copiedFiles == 0) throw IllegalStateException("Capture bundle did not contain extractable files.")
            return ExtractedJoinLobbyAck(export, targetDir, copiedFiles, copiedBytes)
        }
    }

    private fun buildManifest(
        frame: CapturedCounterSideFrame,
        connectionLabel: String,
        rawName: String,
        payloadName: String,
    ): String {
        val sha256 = MessageDigest.getInstance("SHA-256").digest(frame.raw).toLowerHex()
        val escapedConnection = connectionLabel.replace("\\", "\\\\").replace("\"", "\\\"")
        return """
            {
              "source": "android-vpn",
              "capturedAt": "${Instant.now()}",
              "stream": "$escapedConnection",
              "server": [
                {
                  "seq": ${frame.sequence},
                  "packetId": ${frame.packetId},
                  "compressed": ${frame.compressed},
                  "payloadSize": ${frame.payloadSize},
                  "totalLength": ${frame.totalLength},
                  "rawFile": "$rawName",
                  "payloadFile": "$payloadName",
                  "sourcePcap": "android-vpn",
                  "stream": "$escapedConnection",
                  "frame": 0,
                  "time": 0,
                  "sha256": "$sha256"
                }
              ]
            }
        """.trimIndent() + "\n"
    }

    private fun buildCapturedTcpManifest(frames: List<CapturedCounterSideFrame>, connectionLabel: String): String {
        val escapedConnection = connectionLabel.replace("\\", "\\\\").replace("\"", "\\\"")
        val entries = frames.mapIndexed { index, frame ->
            val sha256 = MessageDigest.getInstance("SHA-256").digest(frame.raw).toLowerHex()
            """
              "${frame.packetId}": {
                "packetId": ${frame.packetId},
                "stream": "$escapedConnection",
                "sequence": ${frame.sequence},
                "compressed": ${frame.compressed},
                "payloadSize": ${frame.payloadSize},
                "payloadFile": "${frame.packetId}.payload.bin",
                "rawFile": "${frame.packetId}.packet.bin",
                "totalLength": ${frame.totalLength},
                "tail": 287454020,
                "frame": $index,
                "time": 0,
                "sha256": "$sha256"
              }
            """.trimIndent()
        }
        return "{\n${entries.joinToString(",\n")}\n}\n"
    }

    private const val LOGIN_ACK = 203
    private const val JOIN_LOBBY_ACK = 205
    private const val GAMEBASE_LOGIN_ACK = 230
    private const val CONTENTS_VERSION_ACK = 217
}

internal data class ExtractedJoinLobbyAck(
    val exportFile: File,
    val targetDir: File,
    val copiedFiles: Int,
    val copiedBytes: Long,
)

private fun safeZipDestination(root: File, entryName: String): File? {
    val normalized = entryName.replace('\\', '/').trimStart('/')
    if (normalized.isBlank() || normalized.startsWith("../") || normalized.contains("/../")) return null
    val rootCanonical = root.canonicalFile
    val destination = File(rootCanonical, normalized).canonicalFile
    val rootPath = rootCanonical.path
    val destinationPath = destination.path
    if (destinationPath != rootPath && !destinationPath.startsWith(rootPath + File.separator)) return null
    return destination
}
