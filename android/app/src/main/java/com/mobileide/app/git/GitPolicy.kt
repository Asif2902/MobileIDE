package com.mobileide.app.git

import org.eclipse.jgit.lib.Repository
import java.net.URI
import java.util.Locale

object GitPolicy {
    private val referencePattern = Regex("^[A-Za-z0-9._-]{1,64}$")
    private val projectDirectoryPattern = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
    private val branchPattern = Regex("^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
    private val remoteNamePattern = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
    private val githubOwnerPattern = Regex("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
    private val githubRepositoryPattern = Regex("^[A-Za-z0-9._-]{1,100}$")

    data class GitHubRepository(val owner: String, val name: String)

    fun requireReference(reference: String): String {
        val value = reference.trim()
        require(referencePattern.matches(value)) {
            "Credential reference must be 1-64 letters, digits, dots, underscores, or hyphens"
        }
        return value
    }

    fun requireProjectDirectoryName(name: String): String {
        val value = name.trim()
        require(projectDirectoryPattern.matches(value) && value != "." && value != "..") {
            "Project folder must be a single safe directory name"
        }
        return value
    }

    fun requireBranch(branch: String): String {
        val value = branch.trim().removePrefix("refs/heads/").removePrefix("refs/remotes/")
        require(
            branchPattern.matches(value) &&
                !value.contains("..") &&
                !value.contains("//") &&
            !value.contains("@{") &&
            !value.endsWith('/') &&
            !value.endsWith('.') &&
            !value.endsWith(".lock") &&
            value != "HEAD" &&
            Repository.isValidRefName("refs/heads/$value")
        ) { "Invalid Git branch name" }
        return value
    }

    fun requireRemoteName(remote: String): String {
        val value = remote.trim()
        require(remoteNamePattern.matches(value)) {
            "Git remote name must start with a letter or digit and contain only letters, " +
                "digits, dots, underscores, or hyphens"
        }
        return value
    }

    fun requireRemoteUrl(remoteUrl: String): String {
        val value = remoteUrl.trim()
        require(value.isNotEmpty() && value.none { it == '\u0000' || it == '\r' || it == '\n' }) {
            "Invalid Git remote URL"
        }
        if ("://" in value) {
            val uri = URI(value)
            val isHttp = uri.scheme.equals("http", ignoreCase = true) ||
                uri.scheme.equals("https", ignoreCase = true)
            val userInfo = uri.userInfo
            val embedsCredential = !userInfo.isNullOrBlank() &&
                (isHttp || ':' in userInfo.orEmpty())
            require(!embedsCredential) {
                "Do not put credentials in a remote URL; use the protected Git credential settings"
            }
        }
        return value
    }

    /**
     * Remote metadata crosses the React Native bridge, so remove URL userinfo
     * even for repositories created by an older app version. URI userinfo is
     * presentation-only here, so remove it completely for every URL scheme.
     */
    fun redactRemoteUrl(remoteUrl: String): String {
        val value = remoteUrl.trim()
        val match = Regex(
            "^([A-Za-z][A-Za-z0-9+.-]*://)([^/@\\s]+)@"
        ).find(value) ?: return value
        val scheme = match.groupValues[1]
        return scheme + value.substring(match.range.last + 1)
    }

    /** Parse GitHub HTTPS, ssh://, git://, and SCP-form remotes. */
    fun parseGitHubRepository(remoteUrl: String): GitHubRepository? {
        if (normalizeHost(remoteUrl) != "github.com") return null
        val value = remoteUrl.trim().substringBefore('?').substringBefore('#')
        val scpPath = value
            .takeIf { "://" !in it && ':' in it }
            ?.substringAfter(':')
        val path = scpPath ?: try {
            URI(value).path
        } catch (_: Exception) {
            null
        }?.takeIf { it.isNotBlank() } ?: return null
        val segments = path.trim('/').split('/').filter { it.isNotBlank() }
        if (segments.size != 2) return null
        val owner = segments[0]
        val repository = segments[1].removeSuffix(".git")
        if (!githubOwnerPattern.matches(owner) || !githubRepositoryPattern.matches(repository)) {
            return null
        }
        return GitHubRepository(owner, repository)
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
        // A PAT may be stored as either URL username (`https://token@...`) or
        // password (`https://user:token@...`). Remove the complete userinfo so
        // errors from repositories created by older versions cannot leak it.
        result = result.replace(
            Regex("(?i)(https?://)[^/@\\s]+@"),
            "$1<redacted>@"
        )
        return result
    }
}
