package com.mobileide.app.process

import android.util.Log
import com.mobileide.app.runtime.RuntimeManager
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * ProcessManager handles spawning and managing background processes
 * (dev servers, builds, agent tasks). All spawns get the full ADEV environment.
 *
 * Android 10+ noexec: bare names like `node`/`ls` on PATH often point at
 * filesDir symlinks that cannot be exec'd. We rewrite known commands to
 * absolute ELFs under nativeLibraryDir (or node + npm-cli.js for npm/npx).
 */
class ProcessManager(private val runtimeManager: RuntimeManager) {

    companion object {
        private const val TAG = "ProcessManager"

        val MONITORED_PORTS = listOf(3000, 3001, 4173, 5173, 8000, 8080, 5000, 4000, 8787)

        val SERVER_START_PATTERNS = listOf(
            Regex("listening on.*:(\\d+)", RegexOption.IGNORE_CASE),
            Regex("Local:\\s+https?://(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):(\\d+)", RegexOption.IGNORE_CASE),
            Regex("ready on.*:(\\d+)", RegexOption.IGNORE_CASE),
            Regex("started server on.*:(\\d+)", RegexOption.IGNORE_CASE),
            Regex("Server running at.*:(\\d+)", RegexOption.IGNORE_CASE),
            Regex("VITE.*ready.*(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):(\\d+)", RegexOption.IGNORE_CASE),
            Regex("Next\\.js.*(?:localhost|127\\.0\\.0\\.1):(\\d+)", RegexOption.IGNORE_CASE),
            Regex("http://(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):(\\d+)", RegexOption.IGNORE_CASE)
        )

        /** Busybox multi-call applets we rewrite to: busybox <applet> … */
        val BUSYBOX_APPLETS = setOf(
            "ls", "cat", "cp", "mv", "rm", "mkdir", "rmdir", "ln", "chmod", "chown",
            "touch", "find", "grep", "egrep", "fgrep", "sed", "awk", "head", "tail",
            "wc", "sort", "uniq", "tr", "cut", "xargs", "tee", "diff", "which",
            "whoami", "id", "clear", "sleep", "date", "base64", "md5sum", "sha256sum",
            "sha1sum", "tar", "gzip", "gunzip", "bzip2", "xz", "wget", "vi", "less",
            "more", "ps", "kill", "killall", "pgrep", "pkill", "du", "df", "realpath",
            "dirname", "basename", "seq", "yes", "printf", "echo", "test", "true",
            "false", "env", "printenv", "expr", "stat", "od", "hexdump", "strings",
            "cmp", "comm", "paste", "fold", "expand", "unexpand", "nl", "rev",
            "cksum", "split", "csplit", "install", "sync", "truncate", "dd",
            "readlink", "basename", "dirname", "mktemp", "mkfifo", "mknod",
            "chgrp", "touch", "pwd", "uname", "uptime", "free", "nproc", "getconf",
            "logger", "logname", "tty", "stty", "time", "timeout", "nice", "nohup",
            "ionice", "renice", "flock", "setsid", "chroot", "mount", "umount",
            "losetup", "swapon", "swapoff", "fdisk", "blkid", "lsblk", "lsof",
            "nc", "netstat", "ifconfig", "ip", "ping", "traceroute", "route",
            "arping", "nslookup", "hostname", "dnsdomainname", "ftpget", "ftpput",
            "tftp", "httpd", "telnet", "ssh", "scp", "ash", "sh", "hush",
            "microcom", "reset", "resize", "setconsole", "loadkmap", "dumpkmap",
            "openvt", "deallocvt", "chvt", "fgconsole", "setkeycodes",
            "adduser", "deluser", "addgroup", "delgroup", "passwd", "su", "login",
            "getty", "cryptpw", "mkpasswd", "start-stop-daemon", "run-parts",
            "crontab", "crond", "watch", "iostat", "top", "sysctl", "dmesg",
            "hwclock", "fstrim", "blockdev", "fsck", "mkfs", "mke2fs", "tune2fs",
            "lzma", "unlzma", "lzop", "lzcat", "bzcat", "zcat", "uncompress",
            "ar", "rpm", "rpm2cpio", "dpkg", "dpkg-deb", "ipcalc", "nameif",
            "vconfig", "brctl", "tc", "tunctl", "udhcpc", "udhcpd", "ntpd",
            "rdate", "adjtimex", "fbset", "fbsplash", "loadfont", "setfont",
            "showkey", "kbd_mode", "dumpkmap", "loadkmap", "setkeycodes",
            "patch", "diff3", "sdiff", "ed", "hexedit", "xxd", "bc", "dc",
            "factor", "dos2unix", "unix2dos", "expand", "unexpand", "fmt",
            "pr", "fold", "column", "tac", "shuf", "tsort", "join", "ptx",
            "sum", "cksum", "md5sum", "sha256sum", "sha512sum", "sha3sum",
            "base32", "base64", "uuencode", "uudecode", "volname", "watchdog"
        )
    }

    private val processes = ConcurrentHashMap<Int, ManagedProcess>()
    private val processIdCounter = AtomicInteger(0)
    private val activePorts = ConcurrentHashMap<Int, Int>()

    /**
     * Spawn a process, rewriting node/npm/git/busybox applets to exec-safe paths.
     */
    fun spawnProcess(
        command: String,
        args: List<String> = emptyList(),
        cwd: String? = null,
        onOutput: ((String) -> Unit)? = null,
        onError: ((String) -> Unit)? = null,
        onExit: ((Int) -> Unit)? = null
    ): ManagedProcess {
        val processId = processIdCounter.incrementAndGet()
        val workingDir = File(cwd ?: runtimeManager.getWorkspacesDir())
        val (exe, exeArgs) = resolveCommand(command, args)

        Log.i(TAG, "Spawning process $processId: $exe ${exeArgs.joinToString(" ")}")

        val processBuilder = ProcessBuilder(ArrayList<String>().apply {
            add(exe)
            addAll(exeArgs)
        }).directory(workingDir).redirectErrorStream(false)

        val env = processBuilder.environment()
        env.clear()
        env.putAll(runtimeManager.getEnvironment())

        val process = processBuilder.start()

        val managedProcess = ManagedProcess(
            id = processId,
            process = process,
            command = command,
            args = args,
            workingDirectory = workingDir.absolutePath,
            startTime = System.currentTimeMillis()
        )
        processes[processId] = managedProcess
        startOutputReader(managedProcess, onOutput, onError)

        Thread {
            val exitCode = process.waitFor()
            managedProcess.exitCode = exitCode
            managedProcess.isRunning = false
            activePorts.entries.removeIf { it.value == processId }
            onExit?.invoke(exitCode)
            Log.i(TAG, "Process $processId exited with code $exitCode")
        }.start()

        return managedProcess
    }

    /**
     * Run a full shell line in background with the agent environment
     * (for OpenCode / UI: builds, typecheck, long-running servers).
     * Does not use `set -e` — agents often chain commands where intermediate
     * non-zero exits are intentional. Loads BASH_ENV equivalent explicitly.
     */
    fun spawnShell(
        script: String,
        cwd: String? = null,
        onOutput: ((String) -> Unit)? = null,
        onError: ((String) -> Unit)? = null,
        onExit: ((Int) -> Unit)? = null
    ): ManagedProcess {
        val native = runtimeManager.getNativeLibDir()
        val bash = File(native, "libbin_bash.so")
        val sh = if (bash.exists()) bash.absolutePath else "/system/bin/sh"
        val agentEnv = File(runtimeManager.getHomeDir(), ".adev-agent-env").absolutePath
        val wrappers = File(runtimeManager.getHomeDir(), ".adev-wrappers").absolutePath
        // Prefer agent-env (exports + wrappers + spoof); fall back to wrappers only.
        val wrapped =
            "[ -f \"$agentEnv\" ] && . \"$agentEnv\" || { [ -f \"$wrappers\" ] && . \"$wrappers\"; }; $script"
        // -c only (not -l): env already from getEnvironment(); avoid double-sourcing rc.
        return spawnProcess(sh, listOf("-c", wrapped), cwd, onOutput, onError, onExit)
    }

    /**
     * Map logical commands to absolute ELFs / node entrypoints.
     */
    fun resolveCommand(command: String, args: List<String>): Pair<String, List<String>> {
        val native = runtimeManager.getNativeLibDir()
        val base = command.substringAfterLast('/').substringAfterLast('\\')
        val node = File(native, "libbin_node.so")
        val git = File(native, "libbin_git.so")
        val busybox = File(native, "libbin_busybox.so")
        val bash = File(native, "libbin_bash.so")
        val npmCli = File(runtimeManager.getLibDir(), "node_modules/npm/bin/npm-cli.js")
        val npxCli = File(runtimeManager.getLibDir(), "node_modules/npm/bin/npx-cli.js")
        val corepack = File(runtimeManager.getLibDir(), "node_modules/corepack/dist/corepack.js")

        return when (base) {
            "node" -> if (node.exists()) node.absolutePath to args else command to args
            "git" -> if (git.exists()) git.absolutePath to args else command to args
            "bash" -> if (bash.exists()) bash.absolutePath to args else command to args
            "busybox" -> if (busybox.exists()) busybox.absolutePath to args else command to args
            "npm" -> if (node.exists() && npmCli.exists()) {
                node.absolutePath to listOf(npmCli.absolutePath) + args
            } else command to args
            "npx" -> if (node.exists() && npxCli.exists()) {
                node.absolutePath to listOf(npxCli.absolutePath) + args
            } else command to args
            "corepack", "yarn", "pnpm" -> if (node.exists() && corepack.exists()) {
                val extra = if (base == "corepack") emptyList() else listOf(base)
                node.absolutePath to listOf(corepack.absolutePath) + extra + args
            } else command to args
            "tsc", "eslint", "prettier", "vite", "next", "webpack", "rollup", "esbuild",
            "tsx", "nodemon", "jest", "vitest", "turbo", "nx" -> {
                if (node.exists() && npxCli.exists()) {
                    node.absolutePath to listOf(npxCli.absolutePath, "--yes", base) + args
                } else command to args
            }
            else -> {
                if (BUSYBOX_APPLETS.contains(base) && busybox.exists()) {
                    busybox.absolutePath to listOf(base) + args
                } else if (File(command).isFile) {
                    // Absolute path provided
                    command to args
                } else {
                    // Leave to PATH (system toybox, etc.)
                    command to args
                }
            }
        }
    }

    private fun startOutputReader(
        managedProcess: ManagedProcess,
        onOutput: ((String) -> Unit)?,
        onError: ((String) -> Unit)?
    ) {
        Thread {
            BufferedReader(InputStreamReader(managedProcess.process.inputStream)).use { reader ->
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    line?.let {
                        managedProcess.outputBuffer.add(it)
                        onOutput?.invoke(it)
                        detectPortFromOutput(managedProcess.id, it)
                    }
                }
            }
        }.start()

        Thread {
            BufferedReader(InputStreamReader(managedProcess.process.errorStream)).use { reader ->
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    line?.let {
                        managedProcess.errorBuffer.add(it)
                        onError?.invoke(it)
                        detectPortFromOutput(managedProcess.id, it)
                    }
                }
            }
        }.start()
    }

    private fun detectPortFromOutput(processId: Int, output: String) {
        for (pattern in SERVER_START_PATTERNS) {
            val match = pattern.find(output)
            if (match != null) {
                val port = match.groupValues[1].toIntOrNull()
                if (port != null) {
                    activePorts[port] = processId
                    Log.i(TAG, "Detected server on port $port (process $processId)")
                }
            }
        }
    }

    fun getProcess(processId: Int): ManagedProcess? = processes[processId]
    fun getAllProcesses(): List<ManagedProcess> = processes.values.filter { it.isRunning }

    fun killProcess(processId: Int) {
        processes[processId]?.let { managedProcess ->
            killProcessTree(managedProcess.process)
            managedProcess.isRunning = false
            activePorts.entries.removeIf { it.value == processId }
            Log.i(TAG, "Killed process $processId")
        }
    }

    private fun killProcessTree(process: Process) {
        try {
            val pid = getPid(process)
            if (pid > 0) android.os.Process.killProcess(pid)
        } catch (e: Exception) {
            Log.e(TAG, "Error killing process tree", e)
        }
        process.destroyForcibly()
    }

    private fun getPid(process: Process): Int {
        return try {
            val field = process.javaClass.getDeclaredField("pid")
            field.isAccessible = true
            field.getInt(process)
        } catch (e: Exception) {
            -1
        }
    }

    fun getActivePorts(): Map<Int, Int> = activePorts.toMap()
    fun isPortActive(port: Int): Boolean = activePorts.containsKey(port)
    fun getProcessForPort(port: Int): Int? = activePorts[port]
    fun killAllProcesses() {
        processes.keys.toList().forEach { killProcess(it) }
    }
}

data class ManagedProcess(
    val id: Int,
    val process: Process,
    val command: String,
    val args: List<String>,
    val workingDirectory: String,
    val startTime: Long,
    var isRunning: Boolean = true,
    var exitCode: Int? = null,
    val outputBuffer: MutableList<String> = mutableListOf(),
    val errorBuffer: MutableList<String> = mutableListOf()
) {
    fun getFullCommand(): String = listOf(command).plus(args).joinToString(" ")
    fun getUptime(): Long = System.currentTimeMillis() - startTime
}
