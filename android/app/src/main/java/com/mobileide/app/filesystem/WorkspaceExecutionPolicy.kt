package com.mobileide.app.filesystem

import java.io.File

/**
 * Shared/emulated Android storage is useful for viewing and editing, but it
 * cannot provide the symlink, executable-mode, case, and native-build
 * semantics expected by package managers and framework build tools.
 */
internal object WorkspaceExecutionPolicy {
    const val IMPORT_REQUIRED_MESSAGE =
        "This project is stored on Android shared storage. Some development tools " +
            "require filesystem features that are unavailable here, including symbolic links. " +
            "Import this project into the ADEV workspace to continue."

    private val npmSafeCommands = setOf(
        "help", "view", "info", "search", "list", "ls", "outdated", "doctor", "config"
    )
    private val packageManagerSafeCommands = setOf(
        "help", "why", "list", "ls", "info", "view", "outdated", "config"
    )
    private val gitReadOnlyCommands = setOf(
        "status", "log", "diff", "show", "rev-parse", "describe", "ls-files",
        "ls-tree", "grep", "blame", "shortlog"
    )
    private val nativeBuildCommands = setOf(
        "node-gyp", "make", "cmake", "ninja", "clang", "clang++", "cc", "c++",
        "gcc", "g++", "ld", "ld.lld", "lld", "ar", "llvm-ar", "ranlib", "llvm-ranlib",
        "cargo", "rustc", "autoconf", "automake", "libtool"
    )

    private val optionValues = setOf(
        "--prefix", "--workspace", "--registry", "--cache", "--userconfig", "--filter",
        "--dir", "--cwd", "-c", "-C", "-w"
    )

    fun isSharedPath(path: String): Boolean {
        val normalized = path
            .replace('\\', '/')
            .replace(Regex("/+"), "/")
            .trimEnd('/')
        return normalized == "/sdcard" ||
            normalized.startsWith("/sdcard/") ||
            normalized == "/storage/self/primary" ||
            normalized.startsWith("/storage/self/primary/") ||
            normalized.startsWith("/storage/") ||
            normalized.startsWith("/mnt/media_rw/") ||
            normalized.startsWith("/mnt/runtime/")
    }

    fun isSharedStorage(directory: File): Boolean =
        isSharedPath(directory.absolutePath) ||
            runCatching { isSharedPath(directory.canonicalPath) }.getOrDefault(false)

    fun requiresPrivateWorkspace(command: String, arguments: List<String>): Boolean {
        val base = normalizedCommand(command)
        val lowered = arguments.map { it.lowercase() }
        val diagnostic = lowered.any { it in setOf("--help", "-h", "--version", "-v") }
        val subcommand = firstSubcommand(lowered)
        return when {
            base in nativeBuildCommands -> !diagnostic
            base in setOf("next", "vite", "webpack", "rollup", "esbuild", "turbo", "nx") ->
                !diagnostic
            base in setOf("npx", "pnpx") -> !diagnostic
            base == "npm" ->
                !diagnostic && subcommand.isNotEmpty() && subcommand !in npmSafeCommands
            base in setOf("pnpm", "yarn", "yarnpkg") ->
                !diagnostic && (subcommand.isEmpty() || subcommand !in packageManagerSafeCommands)
            base == "corepack" -> !diagnostic
            base == "git" ->
                !diagnostic && subcommand.isNotEmpty() && subcommand !in gitReadOnlyCommands
            base in setOf("bash", "sh", "adev-npm-shell") && lowered.firstOrNull() == "-c" ->
                shellRequiresPrivateWorkspace(arguments.drop(1).joinToString(" "))
            else -> false
        }
    }

    fun shellRequiresPrivateWorkspace(script: String): Boolean {
        val normalized = script.lowercase().replace(Regex("\\s+"), " ")
        val commands = Regex(
            """(^|[;&|()])\s*(command\s+|env\s+)?(npm|npx|pnpm|pnpx|yarn|yarnpkg|corepack|next|vite|webpack|rollup|esbuild|turbo|nx|node-gyp|make|cmake|ninja|clang(\+\+)?|gcc|g\+\+|cc|c\+\+|cargo|rustc|git)(?:\s+([^;&|()]*))?"""
        )
        return commands.findAll(normalized).any { match ->
            val arguments = match.groupValues[5]
                .trim()
                .split(Regex("\\s+"))
                .filter { it.isNotEmpty() }
            requiresPrivateWorkspace(match.groupValues[3], arguments)
        }
    }

    private fun firstSubcommand(arguments: List<String>): String {
        var skipValue = false
        arguments.forEach { argument ->
            if (skipValue) {
                skipValue = false
            } else if (argument in optionValues) {
                skipValue = true
            } else if (argument == "--") {
                return@forEach
            } else if (!argument.startsWith("-")) {
                return argument
            }
        }
        return ""
    }

    private fun normalizedCommand(command: String): String {
        val filename = command.substringAfterLast('/').substringAfterLast('\\').lowercase()
        if (!filename.startsWith("libbin_") || !filename.endsWith(".so")) return filename
        val nativeName = filename.removePrefix("libbin_").removeSuffix(".so")
        return when {
            nativeName.contains("npm_shell") -> "adev-npm-shell"
            nativeName.contains("node_gyp") -> "node-gyp"
            nativeName.contains("make") -> "make"
            nativeName.contains("clang") -> if (nativeName.contains("++")) "clang++" else "clang"
            nativeName.contains("llvm_ar") -> "llvm-ar"
            nativeName.contains("ld_lld") -> "ld.lld"
            else -> nativeName
        }
    }
}
