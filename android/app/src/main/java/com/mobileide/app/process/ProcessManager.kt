package com.mobileide.app.process

import android.util.Log
import com.mobileide.app.runtime.RuntimeManager
import java.io.BufferedReader
import java.io.File
import java.io.IOException
import java.io.InputStreamReader
import java.util.concurrent.ConcurrentHashMap

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
            "logger", "logname", "tty", "stty", "time", "timeout", "nice", "nohup", "w",
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
    private val taskRegistry = TaskRegistry.shared()

    /**
     * Spawn a process, rewriting node/npm/git/busybox applets to exec-safe paths.
     */
    fun spawnProcess(
        command: String,
        args: List<String> = emptyList(),
        cwd: String? = null,
        taskType: TaskType = inferTaskType(command, args),
        persistent: Boolean = false,
        onOutput: ((Int, String) -> Unit)? = null,
        onError: ((Int, String) -> Unit)? = null,
        onExit: ((Int, Int) -> Unit)? = null
    ): ManagedProcess {
        val workingDir = File(cwd ?: runtimeManager.getWorkspacesDir())
        val (exe, exeArgs) = resolveCommand(command, args)
        val taskId = taskRegistry.create(
            type = taskType,
            source = TaskSource.BACKGROUND,
            command = listOf(command).plus(args).joinToString(" "),
            cwd = workingDir.absolutePath,
            persistent = persistent
        )

        Log.i(TAG, "Spawning task $taskId: $exe ${exeArgs.joinToString(" ")}")

        val requestedCommand = ArrayList<String>().apply {
            add(exe)
            addAll(exeArgs)
        }
        // Put each managed task in its own process group. This lets stop/close
        // terminate nested shells and native-addon compiler children together.
        val busybox = File(runtimeManager.getNativeLibDir(), "libbin_adev_busybox.so")
        val busyboxPayload = File(runtimeManager.getNativeLibDir(), "libbin_busybox.so")
        val pidFile = File(runtimeManager.getTmpDir(), ".process-$taskId.pid")
        if (pidFile.exists()) pidFile.delete()
        val launchCommand = if (busybox.isFile && busyboxPayload.isFile) {
            ArrayList<String>().apply {
                add(busybox.absolutePath)
                add("sh")
                add("-c")
                add("umask 077; echo \$\$ > \"\$1\"; shift; exec \"\$0\" setsid \"\$@\"")
                add(busybox.absolutePath)
                add(pidFile.absolutePath)
                addAll(requestedCommand)
            }
        } else {
            requestedCommand
        }
        val processBuilder = ProcessBuilder(launchCommand)
            .directory(workingDir)
            .redirectErrorStream(false)

        val env = processBuilder.environment()
        env.clear()
        env.putAll(runtimeManager.getEnvironment(workingDir.absolutePath))

        val process = try {
            processBuilder.start()
        } catch (error: Exception) {
            val reason =
                "Could not start ${command}: ${error.message ?: error.javaClass.simpleName}. " +
                    "Run adev-doctor --verbose for PATH and execution diagnostics."
            taskRegistry.failed(taskId, reason)
            throw IOException(reason, error)
        }
        val reportedPid = readReportedPid(pidFile)

        val managedProcess = ManagedProcess(
            id = taskId,
            pid = reportedPid,
            process = process,
            command = command,
            args = args,
            workingDirectory = workingDir.absolutePath,
            startTime = System.currentTimeMillis()
        )
        processes[taskId] = managedProcess
        taskRegistry.started(taskId, reportedPid)
        startOutputReader(managedProcess, onOutput, onError)

        Thread {
            val exitCode = process.waitFor()
            managedProcess.exitCode = exitCode
            managedProcess.isRunning = false
            taskRegistry.exited(taskId, exitCode)
            onExit?.invoke(taskId, exitCode)
            Log.i(TAG, "Task $taskId exited with code $exitCode")
        }.apply {
            name = "adev-task-wait-$taskId"
            isDaemon = true
            start()
        }

        return managedProcess
    }

    /**
     * Android's java.lang.Process does not expose a stable public PID API on all
     * supported releases. The exec-safe launcher reports its own PID instead of
     * reflecting into an implementation-private field.
     */
    private fun readReportedPid(pidFile: File): Int {
        repeat(25) {
            try {
                if (pidFile.isFile) {
                    val pid = pidFile.readText().trim().toIntOrNull()
                    pidFile.delete()
                    if (pid != null && pid > 0) return pid
                }
                Thread.sleep(10)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                return -1
            } catch (_: Exception) {
                return -1
            }
        }
        pidFile.delete()
        return -1
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
        taskType: TaskType = TaskType.SHELL,
        persistent: Boolean = false,
        onOutput: ((Int, String) -> Unit)? = null,
        onError: ((Int, String) -> Unit)? = null,
        onExit: ((Int, Int) -> Unit)? = null
    ): ManagedProcess {
        val native = runtimeManager.getNativeLibDir()
        val bash = File(native, "libbin_bash.so")
        val sh = if (bash.exists()) bash.absolutePath else "/system/bin/sh"
        val agentEnv = File(runtimeManager.getHomeDir(), ".adev-agent-env").absolutePath
        val wrappers = File(runtimeManager.getHomeDir(), ".adev-wrappers").absolutePath
        // Prefer agent-env (exports + wrappers + capability policy); fall back
        // to wrappers only.
        val wrapped =
            "[ -f \"$agentEnv\" ] && . \"$agentEnv\" || { [ -f \"$wrappers\" ] && . \"$wrappers\"; }; $script"
        // -c only (not -l): env already from getEnvironment(); avoid double-sourcing rc.
        return spawnProcess(
            sh,
            listOf("-c", wrapped),
            cwd,
            taskType,
            persistent,
            onOutput,
            onError,
            onExit
        )
    }

    /**
     * Map logical commands to absolute ELFs / node entrypoints.
     */
    fun resolveCommand(command: String, args: List<String>): Pair<String, List<String>> {
        val native = runtimeManager.getNativeLibDir()
        val base = command.substringAfterLast('/').substringAfterLast('\\')
        val node = File(native, "libbin_node.so")
        val git = File(native, "libbin_git.so")
        val busybox = File(native, "libbin_adev_busybox.so")
        val busyboxPayload = File(native, "libbin_busybox.so")
        val busyboxReady = busybox.isFile && busyboxPayload.isFile
        val bash = File(native, "libbin_bash.so")
        val npmCli = File(runtimeManager.getLibDir(), "node_modules/npm/bin/npm-cli.js")
        val npxCli = File(runtimeManager.getLibDir(), "node_modules/npm/bin/npx-cli.js")
        val corepack = File(runtimeManager.getLibDir(), "node_modules/corepack/dist/corepack.js")
        val nextLauncher = File(runtimeManager.getLibDir(), "adev-next.js")
        val directTools = mapOf(
            "curl" to "libbin_curl.so",
            "nano" to "libbin_nano.so",
            "make" to "libbin_adev_make.so",
            "llvm-ar" to "libbin_llvm_ar.so",
            "ar" to "libbin_llvm_ar.so",
            "lld" to "libbin_lld.so",
            "ld.lld" to "libbin_lld.so",
            "pkg-config" to "libbin_pkg_config.so",
            "adev-npm-shell" to "libbin_adev_npm_shell.so",
            "opencode" to "libbin_opencode.so"
        )
        fun findNative(prefix: String): File? =
            File(native).listFiles()
                ?.filter { it.isFile && it.name.startsWith(prefix) && it.name.endsWith(".so") }
                ?.sortedBy { it.name }
                ?.firstOrNull()

        return when (base) {
            "node" -> if (node.exists()) node.absolutePath to args else command to args
            "git" -> if (git.exists()) git.absolutePath to args else command to args
            "bash" -> if (bash.exists()) bash.absolutePath to args else command to args
            "busybox" -> if (busyboxReady) busybox.absolutePath to args else command to args
            "node-gyp" -> {
                val nodeGyp = File(
                    runtimeManager.getLibDir(),
                    "node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
                )
                if (node.exists() && nodeGyp.exists()) {
                    node.absolutePath to listOf(nodeGyp.absolutePath) + args
                } else command to args
            }
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
            "next" -> if (node.exists() && nextLauncher.exists()) {
                node.absolutePath to listOf(nextLauncher.absolutePath) + args
            } else command to args
            "tsc", "eslint", "prettier", "vite", "webpack", "rollup", "esbuild",
            "tsx", "nodemon", "jest", "vitest", "turbo", "nx" -> {
                if (node.exists() && npxCli.exists()) {
                    node.absolutePath to listOf(npxCli.absolutePath, "--yes", base) + args
                } else command to args
            }
            else -> {
                val nativeTool = directTools[base]?.let {
                    File(native, it).takeIf(File::isFile)
                } ?: when (base) {
                    "python", "python3" -> findNative("libbin_python")
                    "clang", "cc", "gcc", "clang++", "c++", "g++" ->
                        findNative("libbin_clang_")
                    else -> null
                }
                if (nativeTool != null) {
                    nativeTool.absolutePath to args
                } else if (BUSYBOX_APPLETS.contains(base) && busyboxReady) {
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
        onOutput: ((Int, String) -> Unit)?,
        onError: ((Int, String) -> Unit)?
    ) {
        Thread {
            BufferedReader(InputStreamReader(managedProcess.process.inputStream)).use { reader ->
                var line: String?
                while (reader.readLine().also { line = it } != null) {
                    line?.let {
                        managedProcess.outputBuffer.add(it)
                        taskRegistry.output(managedProcess.id, "stdout", it)?.let { visible ->
                            onOutput?.invoke(managedProcess.id, visible)
                        }
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
                        taskRegistry.output(managedProcess.id, "stderr", it)?.let { visible ->
                            onError?.invoke(managedProcess.id, visible)
                        }
                    }
                }
            }
        }.start()
    }

    fun getProcess(processId: Int): ManagedProcess? = processes[processId]
    fun getAllProcesses(): List<ManagedProcess> = processes.values.filter { it.isRunning }
    fun getTasks(includeExited: Boolean = true): List<TaskSnapshot> =
        taskRegistry.getTasks(includeExited)
    fun getTask(taskId: Int): TaskSnapshot? = taskRegistry.getTask(taskId)
    fun getTaskLogs(taskId: Int, limit: Int): List<TaskLog> =
        taskRegistry.getLogs(taskId, limit)

    fun killProcess(processId: Int): Boolean {
        val managedProcess = processes[processId] ?: return false
        taskRegistry.stopping(processId)
        killProcessTree(managedProcess)
        managedProcess.isRunning = false
        taskRegistry.exited(processId, 143)
        val clean = taskRegistry.awaitPortsClosed(processId, 2_000)
        if (!clean) {
            Log.w(TAG, "Task $processId stopped but a verified port is still reachable")
        }
        Log.i(TAG, "Killed task $processId (portsClosed=$clean)")
        return clean
    }

    private fun killProcessTree(managedProcess: ManagedProcess) {
        val process = managedProcess.process
        val pid = managedProcess.pid
        try {
            if (pid > 0 && ProcessSignals.isAvailable) {
                ProcessSignals.killGroup(pid, 15) // SIGTERM
                try {
                    process.waitFor(250, java.util.concurrent.TimeUnit.MILLISECONDS)
                    // The launcher can exit while a backgrounded child remains
                    // in the same group. Always follow the grace period with a
                    // group SIGKILL; killpg safely fails if the group is gone.
                    ProcessSignals.killGroup(pid, 9)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    ProcessSignals.killGroup(pid, 9)
                }
            } else {
                descendantPids(pid).asReversed().forEach(android.os.Process::killProcess)
                if (pid > 0) android.os.Process.killProcess(pid)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error killing process tree", e)
        }
        if (process.isAlive) process.destroyForcibly()
    }

    private fun descendantPids(rootPid: Int): List<Int> {
        if (rootPid <= 0) return emptyList()
        val result = mutableListOf<Int>()
        val pending = ArrayDeque<Int>()
        pending.add(rootPid)
        while (pending.isNotEmpty()) {
            val parent = pending.removeFirst()
            val children = try {
                File("/proc/$parent/task/$parent/children").readText()
                    .trim()
                    .split(Regex("\\s+"))
                    .mapNotNull(String::toIntOrNull)
            } catch (_: Exception) {
                emptyList()
            }
            children.forEach {
                if (it !in result) {
                    result.add(it)
                    pending.add(it)
                }
            }
        }
        return result
    }

    fun getActivePorts(): List<VerifiedPort> {
        taskRegistry.refreshNow()
        return taskRegistry.getActivePorts()
    }
    fun isPortActive(port: Int): Boolean {
        taskRegistry.refreshNow()
        return taskRegistry.isPortActive(port)
    }
    fun getProcessForPort(port: Int): Int? =
        getActivePorts().firstOrNull { it.port == port }?.taskId
    fun killAllProcesses() {
        processes.keys.toList().forEach { killProcess(it) }
    }

    private fun inferTaskType(command: String, args: List<String>): TaskType {
        val full = listOf(command).plus(args).joinToString(" ").lowercase()
        return when {
            Regex("""(^|\s)next(\s|$)""").containsMatchIn(full) -> TaskType.NEXT
            Regex("""(^|\s)vite(\s|$)""").containsMatchIn(full) -> TaskType.VITE
            "express" in full -> TaskType.EXPRESS
            Regex("""(^|\s)(test|jest|vitest)(\s|$)""").containsMatchIn(full) -> TaskType.TEST
            Regex("""(^|\s)(build|tsc)(\s|$)""").containsMatchIn(full) -> TaskType.BUILD
            command.substringAfterLast('/').startsWith("node") -> TaskType.NODE
            command.endsWith("sh") -> TaskType.SHELL
            else -> TaskType.GENERIC
        }
    }
}

data class ManagedProcess(
    val id: Int,
    val pid: Int,
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

private object ProcessSignals {
    val isAvailable: Boolean

    init {
        isAvailable = try {
            System.loadLibrary("mobileide-pty")
            true
        } catch (error: UnsatisfiedLinkError) {
            Log.w("ProcessSignals", "Native process-group signals unavailable: ${error.message}")
            false
        }
    }

    private external fun nativeKillProcessGroup(pid: Int, signal: Int): Boolean

    fun killGroup(pid: Int, signal: Int): Boolean =
        pid > 0 && nativeKillProcessGroup(pid, signal)
}
