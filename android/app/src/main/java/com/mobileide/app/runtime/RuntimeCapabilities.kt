package com.mobileide.app.runtime

/**
 * Stable native capability surface used by diagnostics and the JavaScript UI.
 * A false value is an honest capability boundary, never a synthetic command.
 */
data class RuntimeCapabilities(
    val runtimeVersion: String,
    val platform: String,
    val libc: String,
    val abi: String,
    val androidApi: Int,
    val packageResolutionOrder: List<String>,
    val commands: Map<String, Boolean>,
    val nativeBuildReady: Boolean,
    val npmLifecycleReady: Boolean,
    val termuxExecReady: Boolean,
    val privateWorkspaceExecution: Boolean,
    val sharedWorkspaceExecution: Boolean,
    val globalPlatformSpoof: Boolean
)
