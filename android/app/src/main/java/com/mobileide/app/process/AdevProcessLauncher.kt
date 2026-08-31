package com.mobileide.app.process

import com.mobileide.app.runtime.RuntimeManager
import java.io.File
import java.io.IOException

/**
 * The single app-side entry into ADEV process execution.
 *
 * Android does not permit direct execution of scripts or downloaded binaries
 * from filesDir.  Every terminal, background task and agent command therefore
 * enters the APK-native `adev-env` launcher first.  That launcher restores the
 * runtime contract, resolves ADEV command aliases and follows shebang chains
 * before it hands control to the real executable in nativeLibraryDir.
 */
class AdevProcessLauncher(private val runtimeManager: RuntimeManager) {
    data class LaunchSpec(
        val executable: String,
        val arguments: List<String>
    ) {
        fun processBuilderCommand(): List<String> = listOf(executable) + arguments

        /** nativeForkPty expects argv[0] to be present. */
        fun nativeArgv(): Array<String> = processBuilderCommand().toTypedArray()
    }

    private fun launcher(): File =
        File(runtimeManager.getNativeLibDir(), "libbin_adev_env.so")

    fun command(command: String, args: List<String> = emptyList()): LaunchSpec {
        require(command.isNotBlank()) { "ADEV command must not be blank" }
        val nativeLauncher = launcher()
        if (!nativeLauncher.isFile) {
            throw IOException(
                "ADEV compatibility launcher is missing: ${nativeLauncher.absolutePath}"
            )
        }
        return LaunchSpec(
            executable = nativeLauncher.absolutePath,
            arguments = listOf("--adev-run-v1", command, "--") + args
        )
    }

    fun interactiveShell(): LaunchSpec = command("bash", listOf("-i"))

    fun environment(workingDirectory: String? = null): Map<String, String> =
        runtimeManager.getEnvironment(workingDirectory)
}
