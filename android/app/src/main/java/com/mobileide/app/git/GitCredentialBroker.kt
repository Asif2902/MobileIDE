package com.mobileide.app.git

import android.content.Context
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

import com.mobileide.app.security.CliSecretVault

class GitCredentialBroker private constructor(context: Context) {
    companion object {
        private const val TAG = "GitCredentialBroker"
        private const val MAX_REQUEST_CHARS = 1024 * 1024

        @Volatile
        private var instance: GitCredentialBroker? = null

        fun get(context: Context): GitCredentialBroker =
            instance ?: synchronized(this) {
                instance ?: GitCredentialBroker(context.applicationContext).also { instance = it }
            }
    }

    private val store = GitCredentialStore(context)
    private val vault = CliSecretVault.get(context)
    private val sessionBytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
    private val session = Base64.encodeToString(
        sessionBytes,
        Base64.NO_WRAP or Base64.URL_SAFE
    )
    private val workers: ExecutorService = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "adev-git-credential-worker").apply { isDaemon = true }
    }
    private val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))

    init {
        Thread(::acceptLoop, "adev-git-credential-broker").apply {
            isDaemon = true
            start()
        }
    }

    fun environment(): Map<String, String> = mapOf(
        "ADEV_GIT_CREDENTIAL_PORT" to server.localPort.toString(),
        "ADEV_GIT_CREDENTIAL_SESSION" to session
    )

    private fun acceptLoop() {
        while (!server.isClosed) {
            try {
                val socket = server.accept()
                workers.execute { handle(socket) }
            } catch (error: Exception) {
                if (!server.isClosed) Log.w(TAG, "Credential broker accept failed", error)
            }
        }
    }

    private fun handle(socket: Socket) {
        socket.use {
            it.soTimeout = 15_000
            val reader = BufferedReader(
                InputStreamReader(it.getInputStream(), StandardCharsets.UTF_8)
            )
            val writer = BufferedWriter(
                OutputStreamWriter(it.getOutputStream(), StandardCharsets.UTF_8)
            )
            val line = reader.readLine()
            val response = try {
                require(line != null && line.length <= MAX_REQUEST_CHARS) {
                    "Invalid credential broker request"
                }
                val request = JSONObject(line)
                require(sessionMatches(request.optString("session"))) {
                    "Credential broker authentication failed"
                }
                dispatch(request)
            } catch (error: Exception) {
                JSONObject()
                    .put("ok", false)
                    .put("error", error.message ?: "credential broker failure")
            }
            writer.write(response.toString())
            writer.write("\n")
            writer.flush()
        }
    }

    private fun dispatch(request: JSONObject): JSONObject {
        val action = request.optString("action")
        val input = request.optJSONObject("input") ?: JSONObject()
        return when (action) {
            "get" -> {
                val credential = store.findHttps(
                    host = input.optString("host"),
                    usernameHint = input.optString("username").takeIf { it.isNotBlank() }
                )
                JSONObject().put("ok", credential != null).apply {
                    if (credential != null) {
                        put(
                            "credential",
                            JSONObject()
                                .put("username", credential.username)
                                .put("password", credential.password)
                        )
                    } else {
                        put("error", "No protected credential matches this host")
                    }
                }
            }
            "store" -> {
                val password = input.optString("password")
                if (password.isNotEmpty()) {
                    val host = GitPolicy.normalizeHost(input.optString("host"))
                    store.putHttps(
                        reference = "git-" + host
                            .replace(Regex("[^A-Za-z0-9._-]"), "-")
                            .take(50),
                        host = host,
                        username = input.optString("username", "token"),
                        password = password
                    )
                }
                JSONObject().put("ok", true)
            }
            "erase" -> JSONObject().put(
                "ok",
                store.eraseHttps(
                    input.optString("host"),
                    input.optString("username").takeIf { it.isNotBlank() }
                )
            )
            "prepare-ssh" -> {
                val prepared = store.prepareSsh(input.optString("host"))
                JSONObject()
                    .put("ok", true)
                    .put("lease", prepared.lease)
                    .put("sshHome", prepared.sshHome)
                    .put("identityPath", prepared.identityPath)
                    .put("passphrase", prepared.passphrase)
            }
            "cleanup-ssh" -> JSONObject()
                .put("ok", store.cleanupSsh(input.optString("lease")))
            // Generic vault for CLI tools beyond Git. Same authenticated
            // loopback and session rule; values never enter logs or argv.
            // Validation failures throw IllegalArgumentException, which the
            // connection handler reports as {"ok":false,"error":…}.
            "secret-get" -> {
                val value = vault.get(CliSecretVault.requireValidKey(input.optString("key")))
                JSONObject().put("ok", value != null).apply {
                    if (value != null) put("value", value)
                    else put("error", "Secret not found")
                }
            }
            "secret-set" -> JSONObject().put(
                "ok",
                vault.put(input.optString("key"), input.optString("value"))
            )
            "secret-delete" -> JSONObject().put(
                "ok",
                vault.delete(input.optString("key"))
            )
            "secret-list" -> JSONObject()
                .put("ok", true)
                .put("keys", JSONArray(vault.listKeys()))
            else -> JSONObject().put("ok", false).put("error", "Unsupported broker action")
        }
    }

    private fun sessionMatches(candidate: String): Boolean =
        MessageDigest.isEqual(
            candidate.toByteArray(StandardCharsets.UTF_8),
            session.toByteArray(StandardCharsets.UTF_8)
        )
}
