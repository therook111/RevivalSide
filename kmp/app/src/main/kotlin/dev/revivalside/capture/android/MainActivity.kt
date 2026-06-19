package dev.revivalside.capture.android

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.net.VpnService
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Space
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalTime
import java.time.format.DateTimeFormatter

class MainActivity : Activity() {
    private lateinit var packageInput: EditText
    private lateinit var gamePortInput: EditText
    private lateinit var httpPortInput: EditText
    private lateinit var redirectPortsInput: EditText
    private lateinit var joinLobbyAckInput: EditText
    private lateinit var nodePathInput: EditText
    private lateinit var dotnetPathInput: EditText
    private lateinit var listenerStatusText: TextView
    private lateinit var vpnStatusText: TextView
    private lateinit var exportText: TextView
    private lateinit var logText: TextView
    private lateinit var startButton: Button
    private lateinit var stopButton: Button
    private lateinit var captureButton: Button
    private lateinit var extractButton: Button
    private val timeFormat = DateTimeFormatter.ofPattern("HH:mm:ss")
    private val handler = Handler(Looper.getMainLooper())
    private var pendingVpnMode = CounterSideVpnService.MODE_CAPTURE
    private var launchAfterStart = false
    private var launchAfterCapture = false
    private var listenerReadyForLaunch = false
    private var vpnReadyForLaunch = false
    private var startFlowToken = 0

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val message = intent.getStringExtra(CounterSideVpnService.EXTRA_MESSAGE)
                ?: intent.getStringExtra(RevivalSideListenerService.EXTRA_MESSAGE)
                ?: return
            when (intent.action) {
                CounterSideVpnService.ACTION_STATUS -> {
                    vpnStatusText.text = message
                    appendLog("VPN: $message")
                    if (message.startsWith("Redirecting") || message.contains("already", ignoreCase = true)) {
                        vpnReadyForLaunch = true
                        tryLaunchAfterStart()
                    }
                    if (launchAfterCapture && message.startsWith("Recording")) {
                        launchAfterCapture = false
                        appendLog("Launching CounterSide for JOIN_LOBBY_ACK capture")
                        launchCounterSide()
                    }
                    val exportPath = intent.getStringExtra(CounterSideVpnService.EXTRA_EXPORT_PATH)
                    if (!exportPath.isNullOrBlank()) exportText.text = exportPath
                }
                RevivalSideListenerService.ACTION_STATUS -> {
                    listenerStatusText.text = message
                    appendLog("Listener: $message")
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        window.decorView.isFocusableInTouchMode = true
        window.decorView.requestFocus()
        requestNotificationPermissionIfNeeded()
        registerStatusReceiver()
        appendLog("Ready")
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(statusReceiver) }
        super.onDestroy()
    }

    @Deprecated("VPN permission result uses the platform callback for this no-dependency app.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == VPN_REQUEST && resultCode == RESULT_OK) {
            startVpnService(pendingVpnMode)
        } else if (requestCode == VPN_REQUEST && launchAfterStart) {
            failStartOperation("VPN permission was not granted")
        }
    }

    private fun buildUi(): View {
        val settings = RevivalSideSettingsStore.load(this)
        val root = FrameLayout(this).apply {
            background = verticalGradient(0xff101827.toInt(), 0xff322334.toInt())
            isFocusableInTouchMode = true
            descendantFocusability = ViewGroup.FOCUS_BEFORE_DESCENDANTS
        }

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(22), dp(22), dp(174))
        }

        content.addView(TextView(this).apply {
            text = "RevivalSide"
            textSize = 38f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xffffffff.toInt())
        })
        content.addView(TextView(this).apply {
            text = "Android listener"
            textSize = 16f
            setTextColor(0xffcbd5e1.toInt())
            setPadding(0, dp(1), 0, dp(18))
        })

        val statusPanel = panel().apply {
            addView(eyebrow("Status"))
            listenerStatusText = statusText("Idle")
            addView(listenerStatusText)
            vpnStatusText = statusText("VPN idle")
            addView(vpnStatusText)
            addView(chipRow(
                chip("Target", settings.targetPackage.substringAfterLast('.')),
                chip("Port", settings.gamePort.toString()),
            ))
        }
        content.addView(statusPanel, fillWrapWithBottom(dp(14)))

        val configPanel = panel().apply {
            addView(eyebrow("Connection"))
            packageInput = singleLineInput(settings.targetPackage)
            addView(label("CounterSide package"))
            addView(packageInput, fillWrap())

            val portRow = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.START
            }
            gamePortInput = numberInput(settings.gamePort.toString())
            httpPortInput = numberInput(settings.httpPort.toString())
            portRow.addView(fieldColumn("Game", gamePortInput), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            portRow.addView(fieldColumn("HTTP", httpPortInput), LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            addView(portRow)

            redirectPortsInput = singleLineInput(settings.redirectPortsText)
            addView(label("VPN ports"))
            addView(redirectPortsInput, fillWrap())

            joinLobbyAckInput = singleLineInput(settings.joinLobbyAckMode)
            addView(label("JOIN_LOBBY_ACK"))
            addView(joinLobbyAckInput, fillWrap())

            nodePathInput = singleLineInput(settings.nodePath)
            dotnetPathInput = singleLineInput(settings.dotnetPath)
            addView(label("Node path"))
            addView(nodePathInput, fillWrap())
            addView(label("Dotnet path"))
            addView(dotnetPathInput, fillWrap())
        }
        content.addView(configPanel, fillWrapWithBottom(dp(14)))

        val logPanel = panel().apply {
            addView(eyebrow("Activity"))
            logText = TextView(this@MainActivity).apply {
                textSize = 12f
                setTextColor(0xffdbeafe.toInt())
                setPadding(dp(12), dp(10), dp(12), dp(10))
                background = rounded(0xaa06090d.toInt(), dp(10), 0x335f7ea0)
                typeface = Typeface.MONOSPACE
            }
            addView(logText, fillWrap())
        }
        content.addView(logPanel, fillWrapWithBottom(dp(14)))

        val exportPanel = panel().apply {
            addView(eyebrow("Latest Export"))
            exportText = mutedText(CaptureRepository.latestExport(this@MainActivity)?.absolutePath ?: "No export yet", 13f)
            addView(exportText)
        }
        content.addView(exportPanel, fillWrap())

        val scroll = ScrollView(this).apply {
            isFillViewport = false
            addView(content)
        }
        root.addView(scroll, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        root.addView(bottomBar(), FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        return root
    }

    private fun bottomBar(): View {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(14), dp(18), dp(18))
            background = verticalGradient(0xee070b12.toInt(), 0xff0b1020.toInt())

            addView(LinearLayout(this@MainActivity).apply {
                gravity = Gravity.CENTER_VERTICAL
                orientation = LinearLayout.VERTICAL
                addView(TextView(this@MainActivity).apply {
                    text = "Ready"
                    textSize = 13f
                    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                    setTextColor(0xffffffff.toInt())
                })
                addView(mutedText("Local listener + VPN redirect", 12f))
            }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(10)
            })

            val controls = LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
            }

            startButton = Button(this@MainActivity).apply {
                text = "START"
                textSize = 17f
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                setTextColor(0xff06111f.toInt())
                background = rounded(0xfff8fafc.toInt(), dp(10), 0xffffffff.toInt())
                setPadding(dp(10), 0, dp(10), 0)
                minHeight = dp(58)
                setOnClickListener { startOperation() }
                setOnLongClickListener {
                    stopOperation()
                    true
                }
            }
            stopButton = Button(this@MainActivity).apply {
                text = "STOP"
                textSize = 17f
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                setTextColor(0xfffecdd3.toInt())
                background = rounded(0xff220914.toInt(), dp(10), 0xfffb7185.toInt())
                setPadding(dp(10), 0, dp(10), 0)
                minHeight = dp(58)
                setOnClickListener { stopOperation() }
            }
            captureButton = Button(this@MainActivity).apply {
                text = "ACK JSON"
                textSize = 13f
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                setTextColor(0xffdbeafe.toInt())
                background = rounded(0xff111827.toInt(), dp(10), 0xff60a5fa.toInt())
                setPadding(dp(8), 0, dp(8), 0)
                minHeight = dp(58)
                setOnClickListener { startJoinLobbyAckCapture() }
            }
            extractButton = Button(this@MainActivity).apply {
                text = "EXTRACT"
                textSize = 13f
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                setTextColor(0xffd1fae5.toInt())
                background = rounded(0xff071a14.toInt(), dp(10), 0xff34d399.toInt())
                setPadding(dp(8), 0, dp(8), 0)
                minHeight = dp(58)
                setOnClickListener { extractAndCopyLatestJoinLobbyAck() }
            }
            controls.addView(stopButton, LinearLayout.LayoutParams(0, dp(62), 1f).apply {
                rightMargin = dp(8)
            })
            controls.addView(captureButton, LinearLayout.LayoutParams(0, dp(62), 1f).apply {
                rightMargin = dp(8)
            })
            controls.addView(extractButton, LinearLayout.LayoutParams(0, dp(62), 1f).apply {
                rightMargin = dp(8)
            })
            controls.addView(startButton, LinearLayout.LayoutParams(0, dp(62), 1f))
            addView(controls, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }
    }

    private fun startOperation() {
        val settings = saveSettingsFromInputs()
        val token = ++startFlowToken
        startButton.isEnabled = false
        startButton.text = "STARTING"
        launchAfterStart = true
        listenerReadyForLaunch = false
        vpnReadyForLaunch = false
        appendLog("Start requested")
        startListener(settings)
        waitForListenerHealth(settings, token, attempt = 0)
    }

    private fun startJoinLobbyAckCapture() {
        startFlowToken += 1
        launchAfterStart = false
        launchAfterCapture = true
        listenerReadyForLaunch = false
        vpnReadyForLaunch = false
        if (::startButton.isInitialized) {
            startButton.isEnabled = true
            startButton.text = "START"
        }
        appendLog("JOIN_LOBBY_ACK capture requested")
        beginVpnFlow(CounterSideVpnService.MODE_CAPTURE)
    }

    private fun extractAndCopyLatestJoinLobbyAck() {
        val settings = saveSettingsFromInputs()
        val token = ++startFlowToken
        launchAfterStart = false
        launchAfterCapture = false
        listenerReadyForLaunch = false
        vpnReadyForLaunch = false
        setExtractButtonBusy(true)
        appendLog("Extract + copy requested")
        Thread {
            val extracted = runCatching {
                CaptureRepository.extractLatestJoinLobbyAckToCapturedGameFlow(applicationContext)
            }
            runOnUiThread {
                if (token != startFlowToken) return@runOnUiThread
                val error = extracted.exceptionOrNull()
                if (error != null) {
                    appendLog("Extract + copy failed: ${error.message}")
                    setExtractButtonBusy(false)
                    return@runOnUiThread
                }
                val result = extracted.getOrThrow()
                exportText.text = result.targetDir.absolutePath
                appendLog("Copied JOIN_LOBBY_ACK bundle files=${result.copiedFiles} bytes=${result.copiedBytes}")
                startListener(settings)
                waitForListenerHealthForImport(settings, token, attempt = 0)
            }
        }.start()
    }

    private fun stopOperation() {
        startFlowToken += 1
        launchAfterStart = false
        launchAfterCapture = false
        listenerReadyForLaunch = false
        vpnReadyForLaunch = false
        if (::startButton.isInitialized) {
            startButton.isEnabled = true
            startButton.text = "START"
        }
        setExtractButtonBusy(false)
        appendLog("Stop requested")
        stopVpnService()
        stopListener()
    }

    private fun setExtractButtonBusy(busy: Boolean) {
        if (!::extractButton.isInitialized) return
        extractButton.isEnabled = !busy
        extractButton.text = if (busy) "COPYING" else "EXTRACT"
    }

    private fun tryLaunchAfterStart() {
        if (!launchAfterStart || !listenerReadyForLaunch || !vpnReadyForLaunch) return
        launchAfterStart = false
        appendLog("Launching CounterSide")
        startButton.isEnabled = true
        startButton.text = "START"
        launchCounterSide()
    }

    private fun failStartOperation(message: String) {
        launchAfterStart = false
        listenerReadyForLaunch = false
        vpnReadyForLaunch = false
        appendLog(message)
        if (::startButton.isInitialized) {
            startButton.isEnabled = true
            startButton.text = "START"
        }
    }

    private fun waitForListenerHealth(settings: RevivalSideSettings, token: Int, attempt: Int) {
        if (!launchAfterStart || token != startFlowToken) return
        if (attempt == 0) {
            listenerStatusText.text = "Waiting for listener health"
            appendLog("Waiting for listener health on 127.0.0.1:${settings.httpPort}")
        }
        Thread {
            val ready = isListenerHealthReady(settings)
            runOnUiThread {
                if (!launchAfterStart || token != startFlowToken) return@runOnUiThread
                if (ready) {
                    listenerStatusText.text = "Listener ready"
                    appendLog("Listener health ready")
                    waitForListenerWarmup(settings, token)
                    return@runOnUiThread
                }
                if (attempt >= LISTENER_HEALTH_MAX_ATTEMPTS) {
                    failStartOperation("Listener health timed out")
                    return@runOnUiThread
                }
                if (attempt > 0 && attempt % 10 == 0) {
                    appendLog("Still waiting for listener health (${attempt}s)")
                }
                handler.postDelayed({
                    waitForListenerHealth(settings, token, attempt + 1)
                }, LISTENER_HEALTH_INTERVAL_MS)
            }
        }.start()
    }

    private fun waitForListenerWarmup(settings: RevivalSideSettings, token: Int) {
        if (!launchAfterStart || token != startFlowToken) return
        listenerStatusText.text = "Warming lobby data"
        appendLog("Warming lobby data before launch")
        Thread {
            val result = requestListenerWarmup(settings)
            runOnUiThread {
                if (!launchAfterStart || token != startFlowToken) return@runOnUiThread
                if (result.ok) {
                    listenerReadyForLaunch = true
                    listenerStatusText.text = "Listener ready"
                    appendLog("Lobby warmup ready${result.summary.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")
                    beginVpnFlow(CounterSideVpnService.MODE_LISTENER)
                } else {
                    failStartOperation("Lobby warmup failed${result.summary.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")
                }
            }
        }.start()
    }

    private fun waitForListenerHealthForImport(settings: RevivalSideSettings, token: Int, attempt: Int) {
        if (token != startFlowToken) return
        if (attempt == 0) {
            listenerStatusText.text = "Waiting for listener import API"
            appendLog("Waiting for listener import API on 127.0.0.1:${settings.httpPort}")
        }
        Thread {
            val ready = isListenerHealthReady(settings)
            runOnUiThread {
                if (token != startFlowToken) return@runOnUiThread
                if (ready) {
                    listenerStatusText.text = "Listener ready"
                    importLatestOfficialProfile(settings, token)
                    return@runOnUiThread
                }
                if (attempt >= LISTENER_HEALTH_MAX_ATTEMPTS) {
                    appendLog("Listener import API timed out")
                    setExtractButtonBusy(false)
                    return@runOnUiThread
                }
                if (attempt > 0 && attempt % 10 == 0) {
                    appendLog("Still waiting for listener import API (${attempt}s)")
                }
                handler.postDelayed({
                    waitForListenerHealthForImport(settings, token, attempt + 1)
                }, LISTENER_HEALTH_INTERVAL_MS)
            }
        }.start()
    }

    private fun importLatestOfficialProfile(settings: RevivalSideSettings, token: Int) {
        if (token != startFlowToken) return
        appendLog("Importing copied JOIN_LOBBY_ACK profile")
        Thread {
            val result = requestOfficialProfileImport(settings)
            runOnUiThread {
                if (token != startFlowToken) return@runOnUiThread
                if (result.ok) {
                    appendLog("Imported profile${result.summary.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")
                } else {
                    appendLog("Official profile import failed${result.summary.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")
                }
                setExtractButtonBusy(false)
            }
        }.start()
    }

    private fun isListenerHealthReady(settings: RevivalSideSettings): Boolean {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL("http://127.0.0.1:${settings.httpPort}/launcher/api/health").openConnection() as HttpURLConnection).apply {
                connectTimeout = 1000
                readTimeout = 1000
                requestMethod = "GET"
                useCaches = false
            }
            if (connection.responseCode !in 200..299) return false
            val body = connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            val compact = body.filterNot { it.isWhitespace() }
            compact.contains("\"ok\":true") && compact.contains("\"port\":${settings.gamePort}")
        } catch (_: Exception) {
            false
        } finally {
            connection?.disconnect()
        }
    }

    private fun requestListenerWarmup(settings: RevivalSideSettings): WarmupResult {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL("http://127.0.0.1:${settings.httpPort}/launcher/api/warmup").openConnection() as HttpURLConnection).apply {
                connectTimeout = LISTENER_WARMUP_CONNECT_TIMEOUT_MS
                readTimeout = LISTENER_WARMUP_READ_TIMEOUT_MS
                requestMethod = "POST"
                useCaches = false
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val compact = body.filterNot { it.isWhitespace() }
            if (status in 200..299 && compact.contains("\"ok\":true")) {
                WarmupResult(true, extractWarmupSummary(compact))
            } else {
                WarmupResult(false, "HTTP $status")
            }
        } catch (error: Exception) {
            WarmupResult(false, error.message.orEmpty())
        } finally {
            connection?.disconnect()
        }
    }

    private fun requestOfficialProfileImport(settings: RevivalSideSettings): ImportResult {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL("http://127.0.0.1:${settings.httpPort}/launcher/api/official-profile/import-latest").openConnection() as HttpURLConnection).apply {
                connectTimeout = LISTENER_WARMUP_CONNECT_TIMEOUT_MS
                readTimeout = LISTENER_WARMUP_READ_TIMEOUT_MS
                requestMethod = "POST"
                doOutput = true
                useCaches = false
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
            val body = """{"switchActive":true}""".toByteArray(Charsets.UTF_8)
            connection.outputStream.use { it.write(body) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val compact = response.filterNot { it.isWhitespace() }
            if (status in 200..299 && compact.contains("\"ok\":true")) {
                ImportResult(true, extractImportSummary(compact))
            } else {
                ImportResult(false, extractJsonString(compact, "error").ifBlank { "HTTP $status" })
            }
        } catch (error: Exception) {
            ImportResult(false, error.message.orEmpty())
        } finally {
            connection?.disconnect()
        }
    }

    private fun extractWarmupSummary(compactJson: String): String {
        val warmed = Regex("\"warmed\":(\\d+)").find(compactJson)?.groupValues?.getOrNull(1)
        val duration = Regex("\"durationMs\":(\\d+)").find(compactJson)?.groupValues?.getOrNull(1)
        return listOfNotNull(
            warmed?.let { "$it profile(s)" },
            duration?.let { "${it}ms" },
        ).joinToString(" ")
    }

    private fun extractImportSummary(compactJson: String): String {
        val nickname = extractJsonString(compactJson, "nickname")
        val userUid = extractJsonString(compactJson, "userUid")
        val units = Regex("\"units\":(\\d+)").find(compactJson)?.groupValues?.getOrNull(1)
        return listOfNotNull(
            nickname.takeIf { it.isNotBlank() },
            userUid.takeIf { it.isNotBlank() }?.let { "uid=$it" },
            units?.let { "units=$it" },
        ).joinToString(" ")
    }

    private fun extractJsonString(compactJson: String, key: String): String {
        return Regex("\"${Regex.escape(key)}\":\"((?:\\\\.|[^\"])*)\"")
            .find(compactJson)
            ?.groupValues
            ?.getOrNull(1)
            ?.replace("\\\"", "\"")
            ?.replace("\\\\", "\\")
            .orEmpty()
    }

    private fun startListener(settings: RevivalSideSettings = saveSettingsFromInputs()) {
        val service = Intent(this, RevivalSideListenerService::class.java).apply {
            action = RevivalSideListenerService.ACTION_START
        }
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service) else startService(service)
        appendLog("Starting listener on 127.0.0.1:${settings.httpPort}")
    }

    private fun stopListener() {
        startService(Intent(this, RevivalSideListenerService::class.java).apply {
            action = RevivalSideListenerService.ACTION_STOP
        })
        appendLog("Stopping listener")
    }

    private fun beginVpnFlow(mode: String) {
        saveSettingsFromInputs()
        pendingVpnMode = mode
        val intent = VpnService.prepare(this)
        if (intent != null) {
            startActivityForResult(intent, VPN_REQUEST)
        } else {
            startVpnService(mode)
        }
    }

    private fun startVpnService(mode: String) {
        val settings = saveSettingsFromInputs()
        val service = Intent(this, CounterSideVpnService::class.java).apply {
            action = CounterSideVpnService.ACTION_START
            putExtra(CounterSideVpnService.EXTRA_TARGET_PACKAGE, settings.targetPackage)
            putExtra(CounterSideVpnService.EXTRA_MODE, mode)
            putExtra(CounterSideVpnService.EXTRA_LISTENER_PORT, settings.gamePort)
            putExtra(CounterSideVpnService.EXTRA_HTTP_PORT, settings.httpPort)
            putExtra(CounterSideVpnService.EXTRA_REDIRECT_PORTS, settings.redirectPortsText)
        }
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service) else startService(service)
        appendLog(if (mode == CounterSideVpnService.MODE_LISTENER) "Starting VPN redirect" else "Starting official login capture")
    }

    private fun stopVpnService() {
        startService(Intent(this, CounterSideVpnService::class.java).apply {
            action = CounterSideVpnService.ACTION_STOP
        })
        appendLog("Stopping VPN")
    }

    private fun openUserManager() {
        val settings = saveSettingsFromInputs()
        openUrl("http://127.0.0.1:${settings.httpPort}/user-manager")
    }

    private fun launchCounterSide() {
        val settings = saveSettingsFromInputs()
        val launch = packageManager.getLaunchIntentForPackage(settings.targetPackage)
            ?: Intent(Intent.ACTION_MAIN).apply {
                setClassName(settings.targetPackage, "${settings.targetPackage}.CustomActivity")
                addCategory(Intent.CATEGORY_LAUNCHER)
            }
        launch.addFlags(Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        runCatching {
            startActivity(launch)
        }.onSuccess {
            appendLog("CounterSide launch intent sent")
        }.onFailure {
            appendLog("CounterSide launch failed: ${it.message}")
        }
    }

    private fun shareLatestExport() {
        val file = CaptureRepository.latestExport(this)
        if (file == null) {
            appendLog("No export is available yet")
            return
        }
        val uri = Uri.Builder()
            .scheme("content")
            .authority("dev.revivalside.officialprofilecapture.exports")
            .appendPath(file.name)
            .build()
        val share = Intent(Intent.ACTION_SEND).apply {
            type = "application/zip"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(share, "Share RevivalSide capture bundle"))
    }

    private fun openUrl(url: String) {
        runCatching {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        }.onFailure {
            appendLog("Could not open $url: ${it.message}")
        }
    }

    private fun registerStatusReceiver() {
        val filter = IntentFilter().apply {
            addAction(CounterSideVpnService.ACTION_STATUS)
            addAction(RevivalSideListenerService.ACTION_STATUS)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(statusReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(statusReceiver, filter)
        }
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 45)
        }
    }

    private fun saveSettingsFromInputs(): RevivalSideSettings {
        val gamePort = RevivalSideSettingsStore.parsePort(gamePortInput.text.toString(), DEFAULT_GAME_PORT)
        val settings = RevivalSideSettings(
            targetPackage = packageInput.text.toString().trim().ifBlank { DEFAULT_COUNTERSIDE_PACKAGE },
            gamePort = gamePort,
            httpPort = RevivalSideSettingsStore.parsePort(httpPortInput.text.toString(), DEFAULT_HTTP_PORT),
            redirectPorts = RevivalSideSettingsStore.parsePorts(redirectPortsInput.text.toString(), setOf(gamePort)),
            joinLobbyAckMode = RevivalSideSettingsStore.normalizeJoinLobbyAckMode(joinLobbyAckInput.text.toString()),
            nodePath = nodePathInput.text.toString().trim(),
            dotnetPath = dotnetPathInput.text.toString().trim(),
        )
        RevivalSideSettingsStore.save(this, settings)
        return settings
    }

    private fun appendLog(message: String) {
        if (!::logText.isInitialized) return
        val line = "[${LocalTime.now().format(timeFormat)}] $message"
        logText.text = if (logText.text.isNullOrBlank()) line else "${logText.text}\n$line"
    }

    private fun panel(): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(16))
            background = rounded(0xd90a0f19.toInt(), dp(12), 0x335f7ea0)
        }
    }

    private fun eyebrow(text: String): TextView {
        return TextView(this).apply {
            this.text = text.uppercase()
            textSize = 11f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xff93c5fd.toInt())
            setPadding(0, 0, 0, dp(8))
        }
    }

    private fun chipRow(vararg chips: View): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.START
            setPadding(0, dp(4), 0, 0)
            chips.forEachIndexed { index, chip ->
                if (index > 0) addView(Space(this@MainActivity), LinearLayout.LayoutParams(dp(8), 1))
                addView(chip, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            }
        }
    }

    private fun chip(title: String, value: String): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(10), dp(12), dp(10))
            background = rounded(0x66182739, dp(10), 0x246ea8fe)
            addView(TextView(this@MainActivity).apply {
                text = title.uppercase()
                textSize = 10f
                setTextColor(0xff94a3b8.toInt())
            })
            addView(TextView(this@MainActivity).apply {
                text = value
                textSize = 14f
                typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                setTextColor(0xfff8fafc.toInt())
                maxLines = 2
            })
        }
    }

    private fun mutedText(text: String, size: Float): TextView {
        return TextView(this).apply {
            this.text = text
            textSize = size
            setTextColor(0xffcbd5e1.toInt())
            setPadding(0, dp(2), 0, 0)
        }
    }

    private fun label(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            textSize = 12f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xff94a3b8.toInt())
            setPadding(0, dp(10), 0, dp(3))
        }
    }

    private fun statusText(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            textSize = 20f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            setTextColor(0xfff8fafc.toInt())
            setPadding(0, dp(1), 0, dp(6))
        }
    }

    private fun singleLineInput(value: String): EditText {
        return EditText(this).apply {
            setSingleLine(true)
            setText(value)
            textSize = 15f
            setTextColor(0xfff8fafc.toInt())
            setHintTextColor(0xff64748b.toInt())
            setPadding(dp(12), 0, dp(12), 0)
            minHeight = dp(48)
            background = rounded(0x6606090d, dp(9), 0x3364748b)
        }
    }

    private fun numberInput(value: String): EditText {
        return singleLineInput(value).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
        }
    }

    private fun fieldColumn(title: String, input: EditText): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, dp(10), 0)
            addView(label(title))
            addView(input, fillWrap())
        }
    }

    private fun fillWrap(): LinearLayout.LayoutParams {
        return LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    }

    private fun fillWrapWithBottom(bottom: Int): LinearLayout.LayoutParams {
        return LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            bottomMargin = bottom
        }
    }

    private fun rounded(color: Int, radius: Int, strokeColor: Int = 0): GradientDrawable {
        return GradientDrawable().apply {
            setColor(color)
            cornerRadius = radius.toFloat()
            if (strokeColor != 0) setStroke(dp(1), strokeColor)
        }
    }

    private fun verticalGradient(top: Int, bottom: Int): GradientDrawable {
        return GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(top, bottom))
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private companion object {
        const val VPN_REQUEST = 100
        const val LISTENER_HEALTH_MAX_ATTEMPTS = 240
        const val LISTENER_HEALTH_INTERVAL_MS = 1000L
        const val LISTENER_WARMUP_CONNECT_TIMEOUT_MS = 2000
        const val LISTENER_WARMUP_READ_TIMEOUT_MS = 240000
    }

    private data class WarmupResult(val ok: Boolean, val summary: String = "")

    private data class ImportResult(val ok: Boolean, val summary: String = "")
}
