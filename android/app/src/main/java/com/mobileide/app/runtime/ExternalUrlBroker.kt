package com.mobileide.app.runtime

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.system.Os
import android.system.OsConstants
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Authenticated loopback bridge for Unix CLIs such as xdg-open.
 *
 * Android does not expose a desktop xdg-open executable, and /system/bin/am is
 * restricted to the adb shell UID. This broker keeps ACTION_VIEW in the app
 * process while an APK-native client transports one strictly validated URL.
 */
class ExternalUrlBroker private constructor(context: Context) {
    companion object {
        private const val TAG = "ExternalUrlBroker"
        private const val MAX_REQUEST_CHARS = 12 * 1024
        private const val MAX_URL_BYTES = 8 * 1024
        const val CAPABILITY_FILE_NAME = ".adev-url-opener-v1"

        @Volatile
        private var instance: ExternalUrlBroker? = null

        @Volatile
        private var appVisible = false

        fun get(context: Context): ExternalUrlBroker =
            instance ?: synchronized(this) {
                instance ?: ExternalUrlBroker(context.applicationContext).also { instance = it }
            }

        fun setAppVisible(visible: Boolean) {
            appVisible = visible
        }

        /** Shared validation used by both the CLI bridge and React Native API. */
        fun validatedHttpUri(value: String): Uri {
            require(value.toByteArray(StandardCharsets.UTF_8).size <= MAX_URL_BYTES) {
                "URL exceeds the 8 KiB limit"
            }
            require(value.isNotBlank() && value.none { it.code < 0x20 || it.code == 0x7f }) {
                "URL contains an invalid control character"
            }
            val uri = Uri.parse(value)
            val scheme = uri.scheme?.lowercase()
            require((scheme == "http" || scheme == "https") && uri.isHierarchical) {
                "Only hierarchical http/https URLs are allowed"
            }
            require(!uri.host.isNullOrBlank()) { "URL requires a host" }
            return uri
        }
    }

    private val appContext = context.applicationContext
    private val mainHandler = Handler(Looper.getMainLooper())
    private val session = Base64.encodeToString(
        ByteArray(32).also { SecureRandom().nextBytes(it) },
        Base64.NO_WRAP or Base64.URL_SAFE
    )
    private val workers = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "adev-url-opener-worker").apply { isDaemon = true }
    }
    private val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    private val capabilityFile = File(
        File(appContext.filesDir, "runtime/home"),
        CAPABILITY_FILE_NAME
    )

    init {
        try {
            writeCapabilityFile()
        } catch (error: Exception) {
            // Direct shell children can still use the inherited environment;
            // a publication failure must not prevent terminal/runtime startup.
            Log.e(TAG, "Cannot publish private URL opener capability", error)
        }
        Thread(::acceptLoop, "adev-url-opener-broker").apply {
            isDaemon = true
            start()
        }
    }

    fun environment(): Map<String, String> = mapOf(
        "ADEV_URL_OPENER_PORT" to server.localPort.toString(),
        "ADEV_URL_OPENER_SESSION" to session
    )

    /**
     * Bun standalone children can omit inherited environment entries on some
     * Android releases. Keep the rotating broker capability in app-private
     * storage so the native URL helper can recover it without putting the
     * session token in argv. The helper rejects symlinks, non-owner files, and
     * group/world permissions before reading this bounded three-line format.
     */
    private fun writeCapabilityFile() {
        val parent = requireNotNull(capabilityFile.parentFile)
        check(parent.exists() || parent.mkdirs()) { "Cannot create URL broker capability directory" }
        val runtimeRoot = File(appContext.filesDir, "runtime").canonicalFile
        val canonicalParent = parent.canonicalFile
        check(canonicalParent.path.startsWith("${runtimeRoot.path}${File.separator}")) {
            "URL broker capability escaped the private runtime"
        }
        val parentStat = Os.lstat(parent.absolutePath)
        check(OsConstants.S_ISDIR(parentStat.st_mode)) {
            "URL broker capability parent is not a real directory"
        }
        Os.chmod(parent.absolutePath, 0x1C0) // 0700

        val suffix = Base64.encodeToString(
            ByteArray(12).also { SecureRandom().nextBytes(it) },
            Base64.NO_WRAP or Base64.NO_PADDING or Base64.URL_SAFE
        )
        val temporary = File(parent, "${CAPABILITY_FILE_NAME}.tmp-$suffix")
        val payload = "adev-url-opener-v1\n${server.localPort}\n$session\n"
            .toByteArray(StandardCharsets.UTF_8)
        val descriptor = Os.open(
            temporary.absolutePath,
            OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or
                OsConstants.O_CLOEXEC or OsConstants.O_NOFOLLOW,
            0x180 // 0600 from the first byte
        )
        try {
            var offset = 0
            while (offset < payload.size) {
                offset += Os.write(descriptor, payload, offset, payload.size - offset)
            }
            Os.fsync(descriptor)
        } catch (error: Exception) {
            temporary.delete()
            throw error
        } finally {
            Os.close(descriptor)
        }
        Os.rename(temporary.absolutePath, capabilityFile.absolutePath)
        Os.chmod(capabilityFile.absolutePath, 0x180)
    }

    private fun acceptLoop() {
        while (!server.isClosed) {
            try {
                val socket = server.accept()
                workers.execute { handle(socket) }
            } catch (error: Exception) {
                if (!server.isClosed) Log.w(TAG, "URL broker accept failed", error)
            }
        }
    }

    private fun handle(socket: Socket) {
        socket.use {
            it.soTimeout = 5_000
            val reader = BufferedReader(
                InputStreamReader(it.getInputStream(), StandardCharsets.UTF_8)
            )
            val writer = BufferedWriter(
                OutputStreamWriter(it.getOutputStream(), StandardCharsets.UTF_8)
            )
            val line = reader.readLine()
            val response = try {
                require(line != null && line.length <= MAX_REQUEST_CHARS) {
                    "Invalid URL opener request"
                }
                val request = JSONObject(line)
                require(request.optInt("version") == 1 && request.optString("action") == "view") {
                    "Unsupported URL opener request"
                }
                require(sessionMatches(request.optString("session"))) {
                    "URL opener authentication failed"
                }
                openUrl(request.optString("url"))
            } catch (error: Exception) {
                JSONObject()
                    .put("ok", false)
                    .put("error", error.message ?: "URL opener failure")
            }
            writer.write(response.toString())
            writer.write("\n")
            writer.flush()
        }
    }

    private fun openUrl(value: String): JSONObject {
        val uri = validatedHttpUri(value)
        require(appVisible) { "ADEV must be visible before opening a browser" }

        val latch = CountDownLatch(1)
        val result = AtomicReference(
            JSONObject().put("ok", false).put("error", "URL opener timed out")
        )
        mainHandler.post {
            try {
                require(appVisible) { "ADEV is no longer visible" }
                appContext.startActivity(
                    Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
                result.set(JSONObject().put("ok", true))
            } catch (error: Exception) {
                result.set(
                    JSONObject()
                        .put("ok", false)
                        .put("error", error.message ?: "No browser accepted the URL")
                )
            } finally {
                latch.countDown()
            }
        }
        if (!latch.await(5, TimeUnit.SECONDS)) {
            return JSONObject().put("ok", false).put("error", "URL opener timed out")
        }
        return result.get()
    }

    private fun sessionMatches(candidate: String): Boolean =
        MessageDigest.isEqual(
            candidate.toByteArray(StandardCharsets.UTF_8),
            session.toByteArray(StandardCharsets.UTF_8)
        )
}
