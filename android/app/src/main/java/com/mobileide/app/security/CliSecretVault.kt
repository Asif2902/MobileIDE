package com.mobileide.app.security

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Generic encrypted key/value vault for CLI tools.
 *
 * GitHub CLI, Git, Codex, Grok, OpenCode or any shell script can persist a
 * token here through the loopback broker (`adev-secret` on PATH) instead of a
 * plaintext dotfile. Values are sealed as AES/GCM records under an
 * AndroidKeyStore key that never leaves the hardware-backed keystore, and the
 * ciphertext lives in app-private preferences keyed only by a digest of the
 * name, so neither the key names nor the values are readable outside this app
 * UID.
 */
class CliSecretVault private constructor(context: Context) {
    companion object {
        private const val KEY_ALIAS = "adev.cli.secrets.v1"
        private const val PREFS = "adev_cli_secret_vault"
        private const val RECORD_PREFIX = "secret."
        private val KEY_PATTERN = Regex("^[A-Za-z0-9._:@/-]{1,128}$")
        const val MAX_VALUE_CHARS = 64 * 1024

        @Volatile
        private var instance: CliSecretVault? = null

        fun get(context: Context): CliSecretVault =
            instance ?: synchronized(this) {
                instance ?: CliSecretVault(context.applicationContext).also { instance = it }
            }

        fun requireValidKey(key: String): String {
            require(KEY_PATTERN.matches(key)) {
                "Secret keys must match [A-Za-z0-9._:@/-] with a maximum of 128 characters"
            }
            return key
        }
    }

    private val preferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    fun put(key: String, value: String): Boolean {
        CliSecretVault.requireValidKey(key)
        require(value.isNotEmpty()) { "Secret value must not be empty" }
        require(value.length <= MAX_VALUE_CHARS) {
            "Secret value exceeds the $MAX_VALUE_CHARS character limit"
        }
        preferences.edit().putString(
            recordKey(key),
            encrypt(JSONObject().put("key", key).put("value", value).toString())
        ).apply()
        return true
    }

    /** Returns the secret for [key], or null when it does not exist. */
    @Synchronized
    fun get(key: String): String? {
        CliSecretVault.requireValidKey(key)
        val record = decodeRecord(recordKey(key)) ?: return null
        return record.optString("value").takeIf { record.optString("key") == key && it.isNotEmpty() }
    }

    @Synchronized
    fun delete(key: String): Boolean {
        CliSecretVault.requireValidKey(key)
        val storageKey = recordKey(key)
        if (!preferences.contains(storageKey)) return false
        preferences.edit().remove(storageKey).apply()
        return true
    }

    /** Secret key names only; values are never included in listings. */
    @Synchronized
    fun listKeys(): List<String> =
        preferences.all.keys
            .filter { it.startsWith(RECORD_PREFIX) }
            .mapNotNull { entry ->
                try {
                    JSONObject(decrypt(preferences.getString(entry, null) ?: return@mapNotNull null))
                        .optString("key")
                        .takeIf { it.isNotEmpty() }
                } catch (_: Exception) {
                    null
                }
            }
            .sorted()

    private fun decodeRecord(storageKey: String): JSONObject? {
        val sealed = preferences.getString(storageKey, null) ?: return null
        return try {
            val record = JSONObject(decrypt(sealed))
            record.optString("key").takeIf { it.isNotEmpty() }?.let { record }
        } catch (_: Exception) {
            null
        }
    }

    private fun recordKey(key: String): String = RECORD_PREFIX + Base64.encodeToString(
        MessageDigest.getInstance("SHA-256").digest(key.toByteArray(StandardCharsets.UTF_8)),
        Base64.NO_WRAP or Base64.URL_SAFE
    )

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

    private fun decrypt(sealed: String): String {
        val parts = sealed.split(':', limit = 3)
        require(parts.size == 3 && parts[0] == "v1") { "Unsupported secret format" }
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
}
