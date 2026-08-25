package com.mobileide.app.process

import android.system.Os
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import java.util.ArrayDeque
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

enum class TaskType {
    NODE, EXPRESS, VITE, NEXT, BUILD, TEST, SHELL, GENERIC;

    companion object {
        fun from(value: String?): TaskType =
            entries.firstOrNull { it.name.equals(value, ignoreCase = true) } ?: GENERIC
    }
}

enum class TaskSource { BACKGROUND, TERMINAL }
enum class TaskState { STARTING, RUNNING, STOPPING, EXITED, FAILED }

data class TaskLog(
    val stream: String,
    val data: String,
    val timestamp: Long = System.currentTimeMillis()
)

data class VerifiedPort(
    val port: Int,
    val taskId: Int,
    val pid: Int,
    val processGroupId: Int,
    val url: String,
    val source: String,
    val state: String = "LISTENING",
    val verifiedAt: Long = System.currentTimeMillis()
)

data class TaskSnapshot(
    val id: Int,
    val pid: Int,
    val processGroupId: Int,
    val type: TaskType,
    val source: TaskSource,
    val command: String,
    val cwd: String,
    val persistent: Boolean,
    val startTime: Long,
    val state: TaskState,
    val exitCode: Int?,
    val failure: String?,
    val ports: List<VerifiedPort>
) {
    val isRunning: Boolean
        get() = state == TaskState.STARTING ||
            state == TaskState.RUNNING ||
            state == TaskState.STOPPING
}

private data class PortCandidate(
    val port: Int,
    val pid: Int,
    val source: String,
    val observedAt: Long = System.currentTimeMillis()
)

private class TaskRecord(
    val id: Int,
    val type: TaskType,
    val source: TaskSource,
    val command: String,
    val cwd: String,
    val persistent: Boolean,
    val startTime: Long = System.currentTimeMillis()
) {
    @Volatile var pid: Int = -1
    @Volatile var processGroupId: Int = -1
    @Volatile var state: TaskState = TaskState.STARTING
    @Volatile var exitCode: Int? = null
    @Volatile var failure: String? = null
    val logs = Collections.synchronizedList(ArrayList<TaskLog>())
    val candidates = ConcurrentHashMap<Int, PortCandidate>()
    val ports = ConcurrentHashMap<Int, VerifiedPort>()

    fun snapshot(): TaskSnapshot = TaskSnapshot(
        id = id,
        pid = pid,
        processGroupId = processGroupId,
        type = type,
        source = source,
        command = command,
        cwd = cwd,
        persistent = persistent,
        startTime = startTime,
        state = state,
        exitCode = exitCode,
        failure = failure,
        ports = ports.values.sortedBy { it.port }
    )
}

/**
 * Application-wide task registry shared by background ProcessNative tasks and
 * interactive PTY sessions.
 *
 * A port is never published from console text alone. Structured Node listen
 * events, URL text, and /proc socket ownership only create candidates; the
 * registry must then connect successfully to 127.0.0.1 before exposing a URL.
 */
class TaskRegistry private constructor() {
    companion object {
        private const val TAG = "TaskRegistry"
        private const val MAX_LOG_LINES = 2_000
        private const val CANDIDATE_TTL_MS = 30_000L
        private const val SERVER_EVENT_PREFIX = "\u001eADEV_SERVER_EVENT "
        private val URL_PORT_PATTERN = Regex(
            """https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::])(?::(\d{1,5}))?""",
            RegexOption.IGNORE_CASE
        )
        private val LISTEN_PORT_PATTERN = Regex(
            """(?:listening|ready|server|local).*?(?::|\bport\s+)(\d{2,5})""",
            RegexOption.IGNORE_CASE
        )

        @Volatile private var instance: TaskRegistry? = null

        /**
         * When set (RuntimeManager does this during init), every port change is
         * mirrored to this JSON file so the netstat/ss/lsof trampolines can
         * report app-owned listening servers — Android 10+ hides /proc/net from
         * apps, so shell tools cannot read kernel tables directly.
         */
        @Volatile var portSnapshotFile: java.io.File? = null

        fun shared(): TaskRegistry =
            instance ?: synchronized(this) {
                instance ?: TaskRegistry().also { instance = it }
            }
    }

    private val idCounter = AtomicInteger(0)
    private val tasks = ConcurrentHashMap<Int, TaskRecord>()
    private val portListeners = CopyOnWriteArraySet<(List<VerifiedPort>) -> Unit>()
    private val scanner = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "adev-task-port-probe").apply { isDaemon = true }
    }

    init {
        scanner.scheduleWithFixedDelay(
            { try { refreshPorts() } catch (error: Throwable) {
                Log.w(TAG, "Port scan failed: ${error.message}")
            } },
            250,
            500,
            TimeUnit.MILLISECONDS
        )
    }

    fun create(
        type: TaskType,
        source: TaskSource,
        command: String,
        cwd: String,
        persistent: Boolean
    ): Int {
        val id = idCounter.incrementAndGet()
        tasks[id] = TaskRecord(id, type, source, command, cwd, persistent)
        return id
    }

    fun started(taskId: Int, pid: Int, processGroupId: Int = pid) {
        tasks[taskId]?.apply {
            this.pid = pid
            this.processGroupId = processGroupId
            this.state = TaskState.RUNNING
        }
    }

    fun stopping(taskId: Int) {
        tasks[taskId]?.state = TaskState.STOPPING
    }

    fun failed(taskId: Int, message: String) {
        tasks[taskId]?.apply {
            failure = message
            state = TaskState.FAILED
            ports.clear()
        }
        notifyPorts()
    }

    fun exited(taskId: Int, exitCode: Int) {
        tasks[taskId]?.apply {
            this.exitCode = exitCode
            state = if (exitCode == 0) TaskState.EXITED else TaskState.FAILED
        }
        refreshPorts()
    }

    /**
     * Records bounded logs and consumes structured listen/close events emitted
     * by adev-server-events.js. Returns visible output, or null when a chunk
     * contains only internal control records.
     */
    fun output(taskId: Int, stream: String, raw: String): String? {
        val record = tasks[taskId] ?: return raw
        val lines = raw.replace("\r", "").split('\n')
        val visibleLines = mutableListOf<String>()
        lines.filter { it.isNotEmpty() }.forEach { line ->
            val markerAt = line.indexOf(SERVER_EVENT_PREFIX)
            if (markerAt >= 0) {
                handleStructuredEvent(
                    record,
                    line.substring(markerAt + SERVER_EVENT_PREFIX.length)
                )?.let(visibleLines::add)
            } else {
                visibleLines.add(line)
                appendBounded(record, TaskLog(stream, line))
                collectLogCandidates(record, line)
            }
        }
        if (visibleLines.isEmpty()) return null
        return if (raw.contains(SERVER_EVENT_PREFIX)) {
            visibleLines.joinToString("\n") + if (raw.endsWith('\n')) "\n" else ""
        } else {
            raw
        }
    }

    private fun appendBounded(record: TaskRecord, log: TaskLog) {
        synchronized(record.logs) {
            record.logs.add(log)
            while (record.logs.size > MAX_LOG_LINES) record.logs.removeAt(0)
        }
    }

    private fun handleStructuredEvent(record: TaskRecord, json: String): String? {
        try {
            val event = JSONObject(json)
            if (event.optString("event") == "error") {
                val message = event.optString("message", "server listen failed")
                val visible = "Server startup failed: $message"
                appendBounded(record, TaskLog("stderr", visible))
                return visible
            }
            val port = event.optInt("port", -1)
            if (port !in 1..65535) return null
            val pid = event.optInt("pid", record.pid)
            when (event.optString("event")) {
                "listening" -> record.candidates[port] =
                    PortCandidate(port, pid, "NODE_EVENT")
                "close" -> {
                    record.candidates.remove(port)
                    record.ports.remove(port)
                    notifyPorts()
                }
            }
        } catch (error: Exception) {
            Log.w(TAG, "Ignoring malformed server event: ${error.message}")
        }
        return null
    }

    private fun collectLogCandidates(record: TaskRecord, line: String) {
        URL_PORT_PATTERN.findAll(line).forEach { match ->
            match.groupValues.getOrNull(1)?.toIntOrNull()?.let { port ->
                if (port in 1..65535) {
                    record.candidates.putIfAbsent(port, PortCandidate(port, record.pid, "LOG_HINT"))
                }
            }
        }
        LISTEN_PORT_PATTERN.findAll(line).forEach { match ->
            match.groupValues.getOrNull(1)?.toIntOrNull()?.let { port ->
                if (port in 1..65535) {
                    record.candidates.putIfAbsent(port, PortCandidate(port, record.pid, "LOG_HINT"))
                }
            }
        }
    }

    fun getTask(taskId: Int): TaskSnapshot? = tasks[taskId]?.snapshot()

    fun getTasks(includeExited: Boolean = true): List<TaskSnapshot> =
        tasks.values
            .asSequence()
            .map { it.snapshot() }
            .filter { includeExited || it.isRunning }
            .sortedByDescending { it.startTime }
            .toList()

    fun getLogs(taskId: Int, limit: Int = 500): List<TaskLog> {
        val logs = tasks[taskId]?.logs ?: return emptyList()
        synchronized(logs) {
            return logs.takeLast(limit.coerceIn(1, MAX_LOG_LINES))
        }
    }

    fun getActivePorts(): List<VerifiedPort> =
        tasks.values.flatMap { it.ports.values }.sortedBy { it.port }

    fun isPortActive(port: Int): Boolean =
        getActivePorts().any { it.port == port }

    fun addPortListener(listener: (List<VerifiedPort>) -> Unit) {
        portListeners.add(listener)
    }

    fun removePortListener(listener: (List<VerifiedPort>) -> Unit) {
        portListeners.remove(listener)
    }

    fun refreshNow() {
        refreshPorts()
    }

    fun awaitPortsClosed(taskId: Int, timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            refreshPorts()
            if (tasks[taskId]?.ports?.isEmpty() != false) return true
            try {
                Thread.sleep(50)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                break
            }
        }
        refreshPorts()
        return tasks[taskId]?.ports?.isEmpty() != false
    }

    private fun refreshPorts() {
        val listeningSockets = readListeningSockets()
        var changed = false
        val now = System.currentTimeMillis()

        tasks.values.forEach { record ->
            record.candidates.entries.removeIf {
                now - it.value.observedAt > CANDIDATE_TTL_MS
            }

            val pids = taskProcessIds(record)
            val ownedInodes = socketInodes(pids)
            val ownedPorts = mutableSetOf<Int>()
            listeningSockets.forEach { (port, inode) ->
                if (inode in ownedInodes) {
                    ownedPorts.add(port)
                    record.candidates.putIfAbsent(
                        port,
                        PortCandidate(port, pids.firstOrNull() ?: record.pid, "PROC_OWNERSHIP")
                    )
                }
            }

            val valid = mutableSetOf<Int>()
            record.candidates.values.forEach { candidate ->
                val ownershipReady =
                    candidate.source == "NODE_EVENT" ||
                        candidate.source == "PROC_OWNERSHIP" ||
                        candidate.port in ownedPorts
                if (ownershipReady && probeLoopback(candidate.port)) {
                    valid.add(candidate.port)
                    val next = VerifiedPort(
                        port = candidate.port,
                        taskId = record.id,
                        pid = candidate.pid.takeIf { it > 0 } ?: record.pid,
                        processGroupId = record.processGroupId,
                        url = "http://127.0.0.1:${candidate.port}",
                        source = candidate.source
                    )
                    val previous = record.ports.put(candidate.port, next)
                    if (previous == null || previous.source != next.source) changed = true
                }
            }
            record.ports.keys.filter { it !in valid }.forEach {
                record.ports.remove(it)
                changed = true
            }
        }
        if (changed) notifyPorts()
    }

    private fun taskProcessIds(record: TaskRecord): Set<Int> {
        val roots = buildSet {
            if (record.pid > 0) add(record.pid)
            record.candidates.values.mapTo(this) { it.pid }
        }.filter { it > 0 }.toMutableSet()
        if (roots.isEmpty()) return emptySet()

        val pending = ArrayDeque(roots)
        while (pending.isNotEmpty()) {
            val parent = pending.removeFirst()
            readChildren(parent).forEach { child ->
                if (roots.add(child)) pending.add(child)
            }
        }

        // A shell can exit after backgrounding its server. setsid/forkpty makes
        // the original PID the process-group ID, so retain ownership after
        // reparenting by finding processes that still belong to that group.
        val group = record.processGroupId
        if (group > 0) {
            File("/proc").listFiles()
                ?.asSequence()
                ?.mapNotNull { it.name.toIntOrNull() }
                ?.filter { processGroupId(it) == group }
                ?.forEach(roots::add)
        }
        return roots
    }

    private fun readChildren(pid: Int): List<Int> =
        try {
            File("/proc/$pid/task/$pid/children").readText()
                .trim()
                .split(Regex("\\s+"))
                .mapNotNull(String::toIntOrNull)
        } catch (_: Exception) {
            emptyList()
        }

    private fun processGroupId(pid: Int): Int? =
        try {
            val stat = File("/proc/$pid/stat").readText()
            val afterName = stat.substringAfterLast(") ")
            afterName.split(' ').getOrNull(2)?.toIntOrNull()
        } catch (_: Exception) {
            null
        }

    private fun socketInodes(pids: Set<Int>): Set<String> {
        val result = mutableSetOf<String>()
        pids.forEach { pid ->
            File("/proc/$pid/fd").listFiles()?.forEach { fd ->
                try {
                    val target = Os.readlink(fd.absolutePath)
                    if (target.startsWith("socket:[") && target.endsWith("]")) {
                        result.add(target.substring(8, target.length - 1))
                    }
                } catch (_: Exception) {
                    // Android may hide individual descriptors; structured
                    // events and verified log candidates remain available.
                }
            }
        }
        return result
    }

    private fun readListeningSockets(): Map<Int, String> {
        val result = mutableMapOf<Int, String>()
        listOf("/proc/net/tcp", "/proc/net/tcp6").forEach { path ->
            try {
                File(path).useLines { lines ->
                    lines.drop(1).forEach { line ->
                        val fields = line.trim().split(Regex("\\s+"))
                        if (fields.size > 9 && fields[3] == "0A") {
                            val port = fields[1].substringAfter(':').toIntOrNull(16)
                            val inode = fields[9]
                            if (port != null && port in 1..65535) result[port] = inode
                        }
                    }
                }
            } catch (_: Exception) {
                // Some OEM kernels restrict /proc/net. Node events still work.
            }
        }
        return result
    }

    private fun probeLoopback(port: Int): Boolean =
        try {
            Socket().use { socket ->
                socket.connect(InetSocketAddress("127.0.0.1", port), 250)
                true
            }
        } catch (_: Exception) {
            false
        }

    private fun notifyPorts() {
        val snapshot = getActivePorts()
        writeSnapshotFile(snapshot)
        portListeners.forEach { listener ->
            try {
                listener(snapshot)
            } catch (error: Exception) {
                Log.w(TAG, "Port listener failed: ${error.message}")
            }
        }
    }

    private fun writeSnapshotFile(ports: List<VerifiedPort>) {
        val target = portSnapshotFile ?: return
        try {
            val payload = JSONObject()
            payload.put("updatedAt", System.currentTimeMillis())
            val array = org.json.JSONArray()
            ports.forEach { port ->
                val entry = JSONObject()
                entry.put("port", port.port)
                entry.put("pid", port.pid)
                entry.put("processGroupId", port.processGroupId)
                entry.put("taskId", port.taskId)
                entry.put("url", port.url)
                entry.put("source", port.source)
                array.put(entry)
            }
            payload.put("ports", array)
            target.parentFile?.mkdirs()
            val tmp = File(target.parentFile, target.name + ".tmp")
            tmp.writeText(payload.toString())
            if (!tmp.renameTo(target)) {
                tmp.delete()
                // Rename can fail across odd filesystems; fall back to direct.
                target.writeText(payload.toString())
            }
        } catch (error: Exception) {
            Log.w(TAG, "Port snapshot write failed: ${error.message}")
        }
    }
}
