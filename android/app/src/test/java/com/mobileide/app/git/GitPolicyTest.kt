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
    fun redactsUrlPasswordsAndKnownSecrets() {
        val secret = "token-123"
        val output = GitPolicy.redact(
            "fatal https://user:pass@example.test token-123",
            listOf(secret)
        )
        assertFalse(output.contains(secret))
        assertFalse(output.contains(":pass@"))
        assertTrue(output.contains("<redacted>"))
    }
}
