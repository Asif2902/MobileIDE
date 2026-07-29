#include <jni.h>
#include <string>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <pty.h>
#include <cstdlib>
#include <cstring>
#include <android/log.h>

#define LOG_TAG "MobileIDE-PTY"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

/**
 * Set the terminal window size using ioctl
 */
static void set_window_size(int fd, int cols, int rows) {
    struct winsize ws;
    ws.ws_col = static_cast<unsigned short>(cols);
    ws.ws_row = static_cast<unsigned short>(rows);
    ws.ws_xpixel = 0;
    ws.ws_ypixel = 0;
    ioctl(fd, TIOCSWINSZ, &ws);
}

/**
 * Fork a new process with a pseudo-terminal
 * Returns master fd and child pid
 */
extern "C" JNIEXPORT jintArray JNICALL
Java_com_mobileide_app_pty_PtySessionManager_nativeForkPty(
    JNIEnv *env,
    jobject thiz,
    jint session_id,
    jstring shell_path,
    jobjectArray args,
    jobjectArray env_vars,
    jstring cwd,
    jint cols,
    jint rows
) {
    // Convert Java strings to C strings
    const char *shell = env->GetStringUTFChars(shell_path, nullptr);
    const char *work_dir = env->GetStringUTFChars(cwd, nullptr);
    
    // Get arguments
    int argc = env->GetArrayLength(args);
    char **argv = new char*[argc + 1];
    for (int i = 0; i < argc; i++) {
        jstring arg = (jstring)env->GetObjectArrayElement(args, i);
        argv[i] = (char*)env->GetStringUTFChars(arg, nullptr);
    }
    argv[argc] = nullptr;
    
    // Get environment
    int envc = env->GetArrayLength(env_vars);
    char **envp = new char*[envc + 1];
    for (int i = 0; i < envc; i++) {
        jstring e = (jstring)env->GetObjectArrayElement(env_vars, i);
        envp[i] = (char*)env->GetStringUTFChars(e, nullptr);
    }
    envp[envc] = nullptr;
    
    // Create PTY master/slave pair
    int master_fd, slave_fd;
    struct winsize ws;
    ws.ws_col = static_cast<unsigned short>(cols);
    ws.ws_row = static_cast<unsigned short>(rows);
    ws.ws_xpixel = 0;
    ws.ws_ypixel = 0;
    
    if (openpty(&master_fd, &slave_fd, nullptr, nullptr, &ws) < 0) {
        LOGE("openpty failed: %s", strerror(errno));
        env->ReleaseStringUTFChars(shell_path, shell);
        env->ReleaseStringUTFChars(cwd, work_dir);
        
        jintArray result = env->NewIntArray(2);
        jint res[2] = {-1, -1};
        env->SetIntArrayRegion(result, 0, 2, res);
        return result;
    }
    
    // Fork the process
    pid_t pid = fork();
    
    if (pid < 0) {
        LOGE("fork failed: %s", strerror(errno));
        close(master_fd);
        close(slave_fd);
        
        jintArray result = env->NewIntArray(2);
        jint res[2] = {-2, -1};
        env->SetIntArrayRegion(result, 0, 2, res);
        return result;
    }
    
    if (pid == 0) {
        // Child process
        close(master_fd);
        
        // Create new session
        setsid();
        
        // Set controlling terminal
        ioctl(slave_fd, TIOCSCTTY, 0);
        
        // Redirect stdio to slave PTY
        dup2(slave_fd, STDIN_FILENO);
        dup2(slave_fd, STDOUT_FILENO);
        dup2(slave_fd, STDERR_FILENO);
        
        if (slave_fd > STDERR_FILENO) {
            close(slave_fd);
        }
        
        // Change working directory
        if (chdir(work_dir) < 0) {
            LOGE("chdir failed: %s", strerror(errno));
        }
        
        // Set environment
        clearenv();
        for (int i = 0; i < envc; i++) {
            putenv(envp[i]);
        }
        
        // Execute shell
        execve(shell, argv, envp);
        
        // If exec fails
        LOGE("execve failed: %s", strerror(errno));
        _exit(127);
    }
    
    // Parent process
    close(slave_fd);
    
    // Set master fd to non-blocking
    int flags = fcntl(master_fd, F_GETFL, 0);
    fcntl(master_fd, F_SETFL, flags | O_NONBLOCK);
    
    LOGI("Created PTY session %d: master_fd=%d, pid=%d", session_id, master_fd, pid);
    
    // Cleanup
    env->ReleaseStringUTFChars(shell_path, shell);
    env->ReleaseStringUTFChars(cwd, work_dir);
    for (int i = 0; i < argc; i++) {
        jstring arg = (jstring)env->GetObjectArrayElement(args, i);
        env->ReleaseStringUTFChars(arg, argv[i]);
    }
    for (int i = 0; i < envc; i++) {
        jstring e = (jstring)env->GetObjectArrayElement(env_vars, i);
        env->ReleaseStringUTFChars(e, envp[i]);
    }
    delete[] argv;
    delete[] envp;
    
    // Return [master_fd, pid]
    jintArray result = env->NewIntArray(2);
    jint res[2] = {master_fd, pid};
    env->SetIntArrayRegion(result, 0, 2, res);
    return result;
}

/**
 * Write data to PTY master
 */
extern "C" JNIEXPORT void JNICALL
Java_com_mobileide_app_pty_PtyProcess_nativeWrite(
    JNIEnv *env,
    jobject thiz,
    jint fd,
    jbyteArray data,
    jint length
) {
    jbyte *buffer = env->GetByteArrayElements(data, nullptr);
    
    int written = 0;
    while (written < length) {
        int n = write(fd, buffer + written, length - written);
        if (n < 0) {
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                usleep(1000);
                continue;
            }
            LOGE("write failed: %s", strerror(errno));
            break;
        }
        written += n;
    }
    
    env->ReleaseByteArrayElements(data, buffer, JNI_ABORT);
}

/**
 * Read data from PTY master
 */
extern "C" JNIEXPORT jint JNICALL
Java_com_mobileide_app_pty_PtyProcess_nativeRead(
    JNIEnv *env,
    jobject thiz,
    jint fd,
    jbyteArray buffer,
    jint length
) {
    jbyte *buf = env->GetByteArrayElements(buffer, nullptr);
    
    int n = read(fd, buf, length);
    
    if (n < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            n = 0; // No data available
        } else if (errno == EIO) {
            n = -1; // PTY closed
        }
    }
    
    env->ReleaseByteArrayElements(buffer, buf, 0);
    return n;
}

/**
 * Resize PTY window
 */
extern "C" JNIEXPORT void JNICALL
Java_com_mobileide_app_pty_PtyProcess_nativeResize(
    JNIEnv *env,
    jobject thiz,
    jint fd,
    jint cols,
    jint rows
) {
    set_window_size(fd, cols, rows);
}

/**
 * Check if process is still alive
 * Returns -1 if alive, exit code if terminated
 */
extern "C" JNIEXPORT jint JNICALL
Java_com_mobileide_app_pty_PtyProcess_nativeCheckAlive(
    JNIEnv *env,
    jobject thiz,
    jint pid
) {
    int status;
    int result = waitpid(pid, &status, WNOHANG);
    
    if (result == 0) {
        return -1; // Still running
    } else if (result == pid) {
        if (WIFEXITED(status)) {
            return WEXITSTATUS(status);
        } else if (WIFSIGNALED(status)) {
            return 128 + WTERMSIG(status);
        }
        return -1;
    }

    // ECHILD means another path already reaped it; treat it as terminated.
    return errno == ECHILD ? 255 : -1;
}

/**
 * Close PTY file descriptor
 */
extern "C" JNIEXPORT void JNICALL
Java_com_mobileide_app_pty_PtyProcess_nativeClose(
    JNIEnv *env,
    jobject thiz,
    jint fd
) {
    close(fd);
}

/**
 * Wait for process to exit
 */
extern "C" JNIEXPORT jint JNICALL
Java_com_mobileide_app_pty_PtyProcess_nativeWaitFor(
    JNIEnv *env,
    jobject thiz,
    jint pid
) {
    int status;
    int result;
    do {
        result = waitpid(pid, &status, 0);
    } while (result < 0 && errno == EINTR);
    if (result < 0) return errno == ECHILD ? 255 : -1;
    
    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    } else if (WIFSIGNALED(status)) {
        return 128 + WTERMSIG(status);
    }
    return -1;
}

/**
 * Send signal to process
 */
extern "C" JNIEXPORT void JNICALL
Java_com_mobileide_app_pty_PtyProcess_nativeKill(
    JNIEnv *env,
    jobject thiz,
    jint pid,
    jint sig
) {
    // forkpty creates a session/process group whose id is the child pid.
    // Signal the whole terminal job; fall back to the direct child if needed.
    if (kill(-pid, sig) != 0 && errno == ESRCH) {
        kill(pid, sig);
    }
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_mobileide_app_process_ProcessSignals_nativeKillProcessGroup(
    JNIEnv *env,
    jobject thiz,
    jint pid,
    jint sig
) {
    if (pid <= 0) return JNI_FALSE;
    if (kill(-pid, sig) == 0) return JNI_TRUE;
    if (errno == ESRCH && kill(pid, sig) == 0) return JNI_TRUE;
    return JNI_FALSE;
}
