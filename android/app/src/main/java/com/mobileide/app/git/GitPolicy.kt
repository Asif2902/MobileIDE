package com.mobileide.app.git

import java.net.URI
import java.util.Locale

object GitPolicy {
    private val referencePattern = Regex("^[A-Za-z0-9._-]{1,64}$")

    fun requireReference(reference: String): String {
        val value = reference.trim()
        require(referencePattern.matches(value)) {
            "Credential reference must be 1-64 letters, digits, dots, underscores, or hyphens"
        }
        return value
    }

    fun normalizeHost(value: String): String {
        var host = value.trim()
        if (host.isEmpty()) return ""
        try {
            val uriValue = if ("://" in host) host else "ssh://$host"
            URI(uriValue).host?.let { host = it }
        } catch (_: Exception) {
            // Continue with SCP-form and host:port parsing below.
        }
        host = host.substringAfterLast('@')
        if (host.startsWith("[") && host.contains("]")) {
            host = host.substringAfter('[').substringBefore(']')
        } else if (host.count { it == ':' } == 1) {
            host = host.substringBefore(':')
        }
        return host.trim().trimEnd('.').lowercase(Locale.US)
    }

    fun hostMatches(pattern: String, host: String): Boolean {
        val normalizedPattern = normalizeHost(pattern.removePrefix("*."))
        val normalizedHost = normalizeHost(host)
        if (normalizedPattern.isEmpty() || normalizedHost.isEmpty()) return false
        return if (pattern.trim().startsWith("*.")) {
            normalizedHost != normalizedPattern && normalizedHost.endsWith(".$normalizedPattern")
        } else {
            normalizedHost == normalizedPattern
        }
    }

    fun redact(text: String, secrets: Collection<String>): String {
        var result = text
        secrets.filter { it.isNotBlank() }.forEach { secret ->
            result = result.replace(secret, "<redacted>")
        }
        result = result.replace(
            Regex("(?i)(https?://[^\\s:/]+:)[^@\\s]+@"),
            "$1<redacted>@"
        )
        return result
    }
}
