package com.mobileide.app.git

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.system.Os
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class GitCredentialMetadata(
    val reference: String,
    val kind: String,
    val host: String,
    val username: String?,
    val createdAt: Long
)

data class GitHttpsCredential(
    val reference: String,
    val host: String,
    val username: String,
    val password: String
)

data class PreparedSshIdentity(
    val lease: String,
    val sshHome: String,
    val identityPath: String?,
    val passphrase: String?
)

class GitCredentialStore(private val context: Context) {
    companion object {
        private const val KEY_ALIAS = "adev.git.credentials.v1"
        private const val PREFS = "adev_git_secure_records"
        private const val ACTIVE_HTTPS = "active.https"
        private const val ACTIVE_SSH = "active.ssh"
        private const val RECORD_PREFIX = "record."
        private const val KNOWN_HOST_PREFIX = "known."
    }

    private val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val leaseRoot = File(context.cacheDir, "git-ssh-leases")
    private val secureRandom = SecureRandom()

    @Synchronized
    fun putHttps(
        reference: String,
        host: String,
        username: String,
        password: String
    ): GitCredentialMetadata {
        val safeReference = GitPolicy.requireReference(reference)
        require(password.isNotEmpty()) { "Token/password must not be empty" }
        val normalizedHost = GitPolicy.normalizeHost(host)
        require(normalizedHost.isNotEmpty()) { "Credential host must not be empty" }
        val record = JSONObject()
            .put("reference", safeReference)
            .put("kind", "https")
            .put("host", normalizedHost)
            .put("username", username.ifBlank { "token" })
            .put("password", password)
            .put("createdAt", System.currentTimeMillis())
        preferences.edit()
            .putString(recordKey(safeReference), encrypt(record.toString()))
            .putString(ACTIVE_HTTPS, safeReference)
            .apply()
        return metadata(record)
    }

    @Synchronized
    fun putSsh(
        reference: String,
        hostPattern: String,
        username: String,
        privateKey: String,
        passphrase: String?
    ): GitCredentialMetadata {
        val safeReference = GitPolicy.requireReference(reference)
        require(privateKey.contains("PRIVATE KEY")) { "A PEM/OpenSSH private key is required" }
        val normalizedPattern = if (hostPattern.trim().startsWith("*.")) {
            "*.${GitPolicy.normalizeHost(hostPattern.removePrefix("*."))}"
        } else {
            GitPolicy.normalizeHost(hostPattern)
        }
        require(normalizedPattern.isNotBlank()) { "SSH host pattern must not be empty" }
        val record = JSONObject()
            .put("reference", safeReference)
            .put("kind", "ssh")
            .put("host", normalizedPattern)
            .put("username", username.ifBlank { "git" })
            .put("privateKey", privateKey)
            .put("passphrase", passphrase ?: "")
            .put("createdAt", System.currentTimeMillis())
        preferences.edit()
            .putString(recordKey(safeReference), encrypt(record.toString()))
            .putString(ACTIVE_SSH, safeReference)
            .apply()
        return metadata(record)
    }

    @Synchronized
    fun select(reference: String): Boolean {
        val record = getRecord(GitPolicy.requireReference(reference)) ?: return false
        val key = if (record.optString("kind") == "ssh") ACTIVE_SSH else ACTIVE_HTTPS
        preferences.edit().putString(key, reference).apply()
        return true
    }

    @Synchronized
    fun remove(reference: String): Boolean {
        val safeReference = GitPolicy.requireReference(reference)
        if (!preferences.contains(recordKey(safeReference))) return false
        val editor = preferences.edit().remove(recordKey(safeReference))
        if (preferences.getString(ACTIVE_HTTPS, null) == safeReference) editor.remove(ACTIVE_HTTPS)
        if (preferences.getString(ACTIVE_SSH, null) == safeReference) editor.remove(ACTIVE_SSH)
        editor.apply()
        return true
    }

    @Synchronized
    fun list(): List<GitCredentialMetadata> =
        preferences.all.keys
            .filter { it.startsWith(RECORD_PREFIX) }
            .mapNotNull { key ->
                preferences.getString(key, null)?.let(::decryptRecord)?.let(::metadata)
            }
            .sortedWith(compareBy({ it.kind }, { it.host }, { it.reference }))

    @Synchronized
    fun hasAny(): Boolean = preferences.all.keys.any { it.startsWith(RECORD_PREFIX) }

    @Synchronized
    fun findHttps(host: String, usernameHint: String? = null): GitHttpsCredential? {
        val normalizedHost = GitPolicy.normalizeHost(host)
        val records = decodedRecords("https")
        val active = preferences.getString(ACTIVE_HTTPS, null)
        val selected = records.firstOrNull {
            it.optString("reference") == active &&
                GitPolicy.hostMatches(it.optString("host"), normalizedHost)
        } ?: records.firstOrNull {
            GitPolicy.hostMatches(it.optString("host"), normalizedHost) &&
                (usernameHint.isNullOrBlank() || it.optString("username") == usernameHint)
        } ?: return null
        return GitHttpsCredential(
            reference = selected.getString("reference"),
            host = selected.getString("host"),
            username = selected.optString("username", "token"),
            password = selected.getString("password")
        )
    }

    @Synchronized
    fun eraseHttps(host: String, usernameHint: String?): Boolean {
        val match = findHttps(host, usernameHint) ?: return false
        return remove(match.reference)
    }

    @Synchronized
    fun putKnownHost(host: String, keyType: String, keyBase64: String): String {
        val normalizedHost = GitPolicy.normalizeHost(host)
        require(normalizedHost.isNotEmpty()) { "Known host must not be empty" }
        require(keyType.matches(Regex("^[A-Za-z0-9@._+-]+$"))) { "Invalid SSH key type" }
        val decoded = Base64.decode(keyBase64, Base64.DEFAULT)
        require(decoded.isNotEmpty()) { "Invalid SSH host key" }
        val fingerprint = "SHA256:" + Base64.encodeToString(
            MessageDigest.getInstance("SHA-256").digest(decoded),
            Base64.NO_WRAP
        ).trimEnd('=')
        val record = JSONObject()
            .put("host", normalizedHost)
            .put("keyType", keyType)
            .put("key", keyBase64.replace(Regex("\\s+"), ""))
            .put("fingerprint", fingerprint)
            .put("confirmedAt", System.currentTimeMillis())
        preferences.edit().putString(
            knownHostKey(normalizedHost),
            encrypt(record.toString())
        ).apply()
        return fingerprint
    }

    @Synchronized
    fun removeKnownHost(host: String): Boolean {
        val key = knownHostKey(GitPolicy.normalizeHost(host))
        if (!preferences.contains(key)) return false
        preferences.edit().remove(key).apply()
        return true
    }

    @Synchronized
    fun listKnownHosts(): List<JSONObject> =
        preferences.all.keys
            .filter { it.startsWith(KNOWN_HOST_PREFIX) }
            .mapNotNull { key -> preferences.getString(key, null)?.let(::decryptRecord) }
            .sortedBy { it.optString("host") }

    @Synchronized
    fun prepareSsh(host: String): PreparedSshIdentity {
        val normalizedHost = GitPolicy.normalizeHost(host)
        require(normalizedHost.isNotEmpty()) { "SSH host could not be determined" }
        val knownHost = listKnownHosts().firstOrNull {
            GitPolicy.hostMatches(it.optString("host"), normalizedHost)
        } ?: throw IllegalStateException(
            "Unknown SSH host '$normalizedHost'. Confirm its fingerprint in Git settings first."
        )
        val identities = decodedRecords("ssh")
        val active = preferences.getString(ACTIVE_SSH, null)
        val identity = identities.firstOrNull {
            it.optString("reference") == active &&
                GitPolicy.hostMatches(it.optString("host"), normalizedHost)
        } ?: identities.firstOrNull {
            GitPolicy.hostMatches(it.optString("host"), normalizedHost)
        }

        leaseRoot.mkdirs()
        val lease = UUID.randomUUID().toString()
        val sshHome = File(leaseRoot, lease).canonicalFile
        require(sshHome.toPath().startsWith(leaseRoot.canonicalFile.toPath())) {
            "Invalid SSH lease path"
        }
        val sshDir = File(sshHome, ".ssh")
        check(sshDir.mkdirs()) { "Could not create an ephemeral SSH directory" }
        val knownHostsFile = File(sshDir, "known_hosts")
        knownHostsFile.writeText(
            "${knownHost.getString("host")} ${knownHost.getString("keyType")} " +
                "${knownHost.getString("key")}\n"
        )
        chmodPrivate(sshHome, 448)
        chmodPrivate(sshDir, 448)
        chmodPrivate(knownHostsFile, 384)

        var identityPath: String? = null
        var passphrase: String? = null
        if (identity != null) {
            val identityFile = File(sshDir, "identity")
            identityFile.writeText(identity.getString("privateKey").trimEnd() + "\n")
            chmodPrivate(identityFile, 384)
            identityPath = identityFile.absolutePath
            passphrase = identity.optString("passphrase").takeIf { it.isNotEmpty() }
        }
        return PreparedSshIdentity(
            lease = lease,
            sshHome = sshHome.absolutePath,
            identityPath = identityPath,
            passphrase = passphrase
        )
    }

    @Synchronized
    fun cleanupSsh(lease: String): Boolean {
        if (!lease.matches(Regex("^[0-9a-fA-F-]{36}$"))) return false
        val root = leaseRoot.canonicalFile
        val target = File(root, lease).canonicalFile
        if (!target.toPath().startsWith(root.toPath()) || target == root) return false
        return !target.exists() || target.deleteRecursively()
    }

    private fun decodedRecords(kind: String): List<JSONObject> =
        preferences.all.keys
            .filter { it.startsWith(RECORD_PREFIX) }
            .mapNotNull { key -> preferences.getString(key, null)?.let(::decryptRecord) }
            .filter { it.optString("kind") == kind }

    private fun getRecord(reference: String): JSONObject? =
        preferences.getString(recordKey(reference), null)?.let(::decryptRecord)

    private fun metadata(record: JSONObject) = GitCredentialMetadata(
        reference = record.getString("reference"),
        kind = record.getString("kind"),
        host = record.getString("host"),
        username = record.optString("username").takeIf { it.isNotBlank() },
        createdAt = record.optLong("createdAt")
    )

    private fun recordKey(reference: String) = RECORD_PREFIX + hashedKey(reference)
    private fun knownHostKey(host: String) = KNOWN_HOST_PREFIX + hashedKey(host)

    private fun hashedKey(value: String): String = Base64.encodeToString(
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray(StandardCharsets.UTF_8)),
        Base64.NO_WRAP or Base64.URL_SAFE
    )

    private fun decryptRecord(encoded: String): JSONObject? = try {
        JSONObject(decrypt(encoded))
    } catch (_: Exception) {
        null
    }

    private fun encrypt(plainText: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = cipher.doFinal(plainText.toByteArray(StandardCharsets.UTF_8))
        return listOf(
            "v1",
            Base64.encodeToString(cipher.iv, Base64.NO_WRAP),
            Base64.encodeToString(encrypted, Base64.NO_WRAP)
        ).joinToString(":")
    }

    private fun decrypt(encoded: String): String {
        val parts = encoded.split(':', limit = 3)
        require(parts.size == 3 && parts[0] == "v1") { "Unsupported credential format" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            getOrCreateKey(),
            GCMParameterSpec(128, Base64.decode(parts[1], Base64.NO_WRAP))
        )
        return String(
            cipher.doFinal(Base64.decode(parts[2], Base64.NO_WRAP)),
            StandardCharsets.UTF_8
        )
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            "AndroidKeyStore"
        )
        val builder = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            builder.setUnlockedDeviceRequired(true)
        }
        generator.init(builder.build())
        return generator.generateKey()
    }

    private fun chmodPrivate(file: File, mode: Int) {
        try {
            Os.chmod(file.absolutePath, mode)
        } catch (_: Exception) {
            file.setReadable(false, false)
            file.setWritable(false, false)
            file.setExecutable(false, false)
            file.setReadable(true, true)
            file.setWritable(true, true)
            if (file.isDirectory) file.setExecutable(true, true)
        }
    }
}
