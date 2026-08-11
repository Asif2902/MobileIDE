package com.mobileide.app.git

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class GitPolicyTest {
    @Test
    fun normalizesHttpsSshAndScpHosts() {
        assertEquals("github.com", GitPolicy.normalizeHost("https://GitHub.com/org/repo.git"))
        assertEquals("github.com", GitPolicy.normalizeHost("git@GitHub.com:org/repo.git"))
        assertEquals("example.test", GitPolicy.normalizeHost("ssh://git@example.test:2222/repo"))
        assertEquals("2001:db8::1", GitPolicy.normalizeHost("[2001:db8::1]:2222"))
    }

    @Test
    fun wildcardHostDoesNotMatchApex() {
        assertTrue(GitPolicy.hostMatches("*.example.test", "git.example.test"))
        assertFalse(GitPolicy.hostMatches("*.example.test", "example.test"))
        assertFalse(GitPolicy.hostMatches("*.example.test", "notexample.test"))
    }

    @Test
    fun referencesCannotEscapeStorageNamespace() {
        assertEquals("github-work", GitPolicy.requireReference("github-work"))
        for (invalid in listOf("../secret", "with space", "", "a".repeat(65))) {
            try {
                GitPolicy.requireReference(invalid)
                fail("Expected invalid reference: $invalid")
            } catch (_: IllegalArgumentException) {
                // Expected.
            }
        }
    }

    @Test
    fun privateProjectNamesAndBranchesCannotEscapeTheirNamespace() {
        assertEquals("mobile-app", GitPolicy.requireProjectDirectoryName("mobile-app"))
        assertEquals("feature/android-ui", GitPolicy.requireBranch("feature/android-ui"))
        assertEquals("origin", GitPolicy.requireRemoteName("origin"))
        for (invalid in listOf("../outside", "nested/project", ".", "two words")) {
            try {
                GitPolicy.requireProjectDirectoryName(invalid)
                fail("Expected invalid project directory: $invalid")
            } catch (_: IllegalArgumentException) {
                // Expected.
            }
        }
        for (invalid in listOf(
            "../main", "-upload-pack", "feature//broken", "branch.lock", "bad branch",
            "HEAD", "feature/./x", "foo/.bar"
        )) {
            try {
                GitPolicy.requireBranch(invalid)
                fail("Expected invalid branch: $invalid")
            } catch (_: IllegalArgumentException) {
                // Expected.
            }
        }
        for (invalid in listOf("--all", "-origin", "nested/remote", "bad remote", "")) {
            try {
                GitPolicy.requireRemoteName(invalid)
                fail("Expected invalid remote name: $invalid")
            } catch (_: IllegalArgumentException) {
                // Expected.
            }
        }
    }

    @Test
    fun parsesSupportedGitHubRemoteForms() {
        val https = GitPolicy.parseGitHubRepository("https://github.com/acme/mobile-app.git")
        assertEquals("acme", https?.owner)
        assertEquals("mobile-app", https?.name)

        val scp = GitPolicy.parseGitHubRepository("git@github.com:acme/mobile-app.git")
        assertEquals("acme", scp?.owner)
        assertEquals("mobile-app", scp?.name)

        assertEquals(null, GitPolicy.parseGitHubRepository("https://example.test/acme/app.git"))
        assertEquals(null, GitPolicy.parseGitHubRepository("https://github.com/too/many/parts.git"))
    }

    @Test
    fun remoteUrlsNeverCarryCredentialsOrControlCharacters() {
        assertEquals(
            "https://github.com/acme/app.git",
            GitPolicy.requireRemoteUrl("https://github.com/acme/app.git")
        )
        assertEquals(
            "git@github.com:acme/app.git",
            GitPolicy.requireRemoteUrl("git@github.com:acme/app.git")
        )
        assertEquals(
            "ssh://git@github.com/acme/app.git",
            GitPolicy.requireRemoteUrl("ssh://git@github.com/acme/app.git")
        )
        for (invalid in listOf(
            "https://user:secret@github.com/acme/app.git",
            "https://token@github.com/acme/app.git",
            "ssh://git:secret@github.com/acme/app.git",
            "https://github.com/acme/app.git\n--upload-pack=bad"
        )) {
            try {
                GitPolicy.requireRemoteUrl(invalid)
                fail("Expected unsafe remote URL: $invalid")
            } catch (_: IllegalArgumentException) {
                // Expected.
            }
        }
    }

    @Test
    fun remoteMetadataNeverExposesEmbeddedCredentials() {
        assertEquals(
            "https://github.com/acme/app.git",
            GitPolicy.redactRemoteUrl("https://user:secret@github.com/acme/app.git")
        )
        assertEquals(
            "https://github.com/acme/app.git",
            GitPolicy.redactRemoteUrl("https://token@github.com/acme/app.git")
        )
        assertEquals(
            "ssh://github.com/acme/app.git",
            GitPolicy.redactRemoteUrl("ssh://git:secret@github.com/acme/app.git")
        )
        assertEquals(
            "ssh://github.com/acme/app.git",
            GitPolicy.redactRemoteUrl("ssh://git%3Asecret@github.com/acme/app.git")
        )
        assertEquals(
            "git@github.com:acme/app.git",
            GitPolicy.redactRemoteUrl("git@github.com:acme/app.git")
        )
    }

    @Test
    fun redactsUrlPasswordsAndKnownSecrets() {
        val secret = "token-123"
        val output = GitPolicy.redact(
            "fatal https://user:pass@example.test https://token-only@example.test token-123",
            listOf(secret)
        )
        assertFalse(output.contains(secret))
        assertFalse(output.contains(":pass@"))
        assertFalse(output.contains("token-only"))
        assertTrue(output.contains("<redacted>"))
    }
}
