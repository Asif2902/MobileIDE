package com.mobileide.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mobileide.app.process.TaskRegistry
import com.mobileide.app.process.TaskSource
import com.mobileide.app.process.TaskType
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket

/**
 * Proves the TaskRegistry port pipeline works on Android 10+, where /proc/net
 * is hidden from apps: a structured listen event plus a successful loopback
 * probe must publish the port (and mirror it to the snapshot file that the
 * netstat/ss/lsof trampolines render), and closing must unpublish it.
 */
@RunWith(AndroidJUnit4::class)
class TaskRegistryPortsTest {

    @Test
    fun portsPublishFromEventsAndProbesWithoutProcNet() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val snapshot = File(context.cacheDir, "adev-ports-test.json")
        snapshot.delete()
        TaskRegistry.portSnapshotFile = snapshot

        val registry = TaskRegistry.shared()

        ServerSocket().use { server ->
            server.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
            val port = server.localPort

            val taskId = registry.create(
                TaskType.NODE,
                TaskSource.BACKGROUND,
                "node server.js",
                context.cacheDir.path,
                false
            )
            registry.started(taskId, pid = android.os.Process.myPid())
            val visible = registry.output(
                taskId,
                "stdout",
                "\u001eADEV_SERVER_EVENT {\"event\":\"listening\",\"port\":$port}\n"
            )

            // The control record is consumed, never shown to users.
            assertTrue(visible?.contains("ADEV_SERVER_EVENT") != true)

            val deadline = System.currentTimeMillis() + 5_000
            var published = false
            while (System.currentTimeMillis() < deadline) {
                published = registry.getActivePorts().any {
                    it.port == port && it.taskId == taskId
                }
                if (published) break
                Thread.sleep(100)
            }
            assertTrue("listening port was not published", published)
            assertTrue("snapshot file missing", snapshot.isFile)
            assertTrue(
                "snapshot does not mention the port",
                snapshot.readText().contains("\"port\":$port")
            )
            assertTrue(registry.isPortActive(port))

            // Closing the server must remove it again.
            server.close()
            val closeDeadline = System.currentTimeMillis() + 5_000
            var removed = false
            while (System.currentTimeMillis() < closeDeadline) {
                removed = registry.getActivePorts().none { it.port == port }
                if (removed) break
                Thread.sleep(100)
            }
            assertTrue("closed port is still listed", removed)

            registry.exited(taskId, 0)
        }
    }
}
