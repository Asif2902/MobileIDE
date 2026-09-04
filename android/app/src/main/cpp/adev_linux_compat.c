#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <ucontext.h>
#include <unistd.h>

typedef long (*adev_syscall_fn)(long, ...);
typedef int (*adev_sigaction_fn)(int, const struct sigaction *, struct sigaction *);

static adev_syscall_fn adev_next_syscall;
static adev_sigaction_fn adev_next_sigaction;
static uid_t adev_uid;
static uid_t adev_euid;
static gid_t adev_gid;
static gid_t adev_egid;
static struct sigaction adev_qemu_sigsys_action;
static volatile sig_atomic_t adev_qemu_sigsys_action_valid;
static volatile sig_atomic_t adev_seccomp_report_count;

#ifndef SYS_SECCOMP
#define SYS_SECCOMP 1
#endif

static size_t append_text(char *destination, size_t offset, size_t capacity, const char *text) {
    while (text != NULL && *text != '\0' && offset < capacity) {
        destination[offset++] = *text++;
    }
    return offset;
}

static size_t append_decimal(char *destination, size_t offset, size_t capacity, int value) {
    char reversed[16];
    size_t count = 0;
    unsigned int number = value < 0 ? (unsigned int)(-value) : (unsigned int)value;
    if (value < 0 && offset < capacity) destination[offset++] = '-';
    do {
        reversed[count++] = (char)('0' + number % 10U);
        number /= 10U;
    } while (number != 0U && count < sizeof(reversed));
    while (count > 0 && offset < capacity) destination[offset++] = reversed[--count];
    return offset;
}

static bool return_enosys_from_seccomp(void *context) {
    if (context == NULL) return false;
    ucontext_t *ucontext = (ucontext_t *)context;
#if defined(__aarch64__)
    ucontext->uc_mcontext.regs[0] = (unsigned long)-ENOSYS;
    return true;
#elif defined(__x86_64__) && defined(REG_RAX)
    ucontext->uc_mcontext.gregs[REG_RAX] = (greg_t)-ENOSYS;
    return true;
#else
    (void)ucontext;
    return false;
#endif
}

static void forward_sigsys(int signal_number, siginfo_t *info, void *context) {
    if (!adev_qemu_sigsys_action_valid) _exit(128 + signal_number);
    const struct sigaction action = adev_qemu_sigsys_action;
    if (action.sa_handler == SIG_IGN) return;
    if (action.sa_handler == SIG_DFL || action.sa_handler == NULL) {
        struct sigaction default_action;
        memset(&default_action, 0, sizeof(default_action));
        default_action.sa_handler = SIG_DFL;
        sigemptyset(&default_action.sa_mask);
        if (adev_next_sigaction != NULL) {
            adev_next_sigaction(signal_number, &default_action, NULL);
            kill(getpid(), signal_number);
        }
        _exit(128 + signal_number);
    }
    if ((action.sa_flags & SA_SIGINFO) != 0) {
        action.sa_sigaction(signal_number, info, context);
    } else {
        action.sa_handler(signal_number);
    }
}

/*
 * Some QEMU host operations use inline/raw syscalls and therefore cannot be
 * intercepted by the syscall(2) wrapper below. Android's seccomp policy sends
 * SIGSYS for those calls. Preserve QEMU's own SIGSYS handler for real guest
 * signals, but turn host SYS_SECCOMP traps into the Linux-compatible ENOSYS
 * result that linux-user normally returns for an unsupported syscall. The
 * diagnostic contains the exact host syscall number and uses only async-
 * signal-safe write(2).
 */
static void adev_sigsys_dispatch(int signal_number, siginfo_t *info, void *context) {
    if (info != NULL && info->si_code == SYS_SECCOMP && return_enosys_from_seccomp(context)) {
        if (adev_seccomp_report_count++ < 8) {
            char message[128];
            size_t length = append_text(
                message,
                0,
                sizeof(message),
                "ADEV linux: Android seccomp blocked host syscall "
            );
            length = append_decimal(message, length, sizeof(message), info->si_syscall);
            length = append_text(message, length, sizeof(message), "; returned ENOSYS\n");
            (void)write(STDERR_FILENO, message, length);
        }
        return;
    }
    forward_sigsys(signal_number, info, context);
}

__attribute__((constructor)) static void adev_linux_compat_init(void) {
    adev_next_syscall = (adev_syscall_fn)dlsym(RTLD_NEXT, "syscall");
    adev_next_sigaction = (adev_sigaction_fn)dlsym(RTLD_NEXT, "sigaction");
    adev_uid = getuid();
    adev_euid = geteuid();
    adev_gid = getgid();
    adev_egid = getegid();
}

int sigaction(int signal_number, const struct sigaction *action, struct sigaction *old_action) {
    if (adev_next_sigaction == NULL) {
        errno = ENOSYS;
        return -1;
    }
    if (signal_number != SIGSYS) {
        return adev_next_sigaction(signal_number, action, old_action);
    }

    if (old_action != NULL) {
        if (adev_qemu_sigsys_action_valid) {
            *old_action = adev_qemu_sigsys_action;
        } else if (adev_next_sigaction(signal_number, NULL, old_action) != 0) {
            return -1;
        }
    }
    if (action == NULL) return 0;

    adev_qemu_sigsys_action = *action;
    adev_qemu_sigsys_action_valid = 1;
    struct sigaction bridge = *action;
    bridge.sa_sigaction = adev_sigsys_dispatch;
    bridge.sa_flags |= SA_SIGINFO;
    bridge.sa_flags &= ~SA_RESETHAND;
    return adev_next_sigaction(signal_number, &bridge, NULL);
}

static bool unchanged_id(unsigned long value, unsigned long current) {
    return value == (unsigned long)-1 || value == (unsigned long)(uint32_t)-1 || value == current;
}

static long permission_denied(void) {
    errno = EPERM;
    return -1;
}

/*
 * QEMU linux-user's credential helpers call libc syscall(2) directly. Android
 * traps those host calls with SIGSYS in ordinary app processes. Interpose at
 * that narrow QEMU boundary: harmless same-identity operations are Linux no-ops
 * and attempted privilege/identity changes fail with EPERM. Nothing is granted
 * beyond the Android app UID/GID and no guest-specific executable is named.
 */
long syscall(long number, ...) {
    va_list values;
    va_start(values, number);
    unsigned long arguments[6];
    for (size_t index = 0; index < 6; ++index) arguments[index] = va_arg(values, unsigned long);
    va_end(values);

    switch (number) {
#ifdef __NR_setgid
        case __NR_setgid:
            return (unchanged_id(arguments[0], adev_gid) ||
                    unchanged_id(arguments[0], adev_egid)) ? 0 : permission_denied();
#endif
#ifdef __NR_setuid
        case __NR_setuid:
            return (unchanged_id(arguments[0], adev_uid) ||
                    unchanged_id(arguments[0], adev_euid)) ? 0 : permission_denied();
#endif
#ifdef __NR_setregid
        case __NR_setregid:
            return unchanged_id(arguments[0], adev_gid) &&
                unchanged_id(arguments[1], adev_egid) ? 0 : permission_denied();
#endif
#ifdef __NR_setreuid
        case __NR_setreuid:
            return unchanged_id(arguments[0], adev_uid) &&
                unchanged_id(arguments[1], adev_euid) ? 0 : permission_denied();
#endif
#ifdef __NR_setresgid
        case __NR_setresgid:
            return unchanged_id(arguments[0], adev_gid) &&
                unchanged_id(arguments[1], adev_egid) &&
                unchanged_id(arguments[2], adev_egid) ? 0 : permission_denied();
#endif
#ifdef __NR_setresuid
        case __NR_setresuid:
            return unchanged_id(arguments[0], adev_uid) &&
                unchanged_id(arguments[1], adev_euid) &&
                unchanged_id(arguments[2], adev_euid) ? 0 : permission_denied();
#endif
#ifdef __NR_setgroups
        case __NR_setgroups:
            // Pretending to drop supplementary groups would give the guest a
            // false security guarantee while Android keeps them unchanged.
            return permission_denied();
#endif
#ifdef __NR_setfsuid
        case __NR_setfsuid:
            // Linux returns the previous fsuid whether or not the change wins.
            return (long)adev_euid;
#endif
#ifdef __NR_setfsgid
        case __NR_setfsgid:
            return (long)adev_egid;
#endif
        default:
            break;
    }

    if (adev_next_syscall == NULL) {
        errno = ENOSYS;
        return -1;
    }
    // Linux syscalls accept at most six arguments. Extra register values are
    // ignored by lower-arity calls, so this preserves QEMU's variadic ABI.
    return adev_next_syscall(
        number,
        arguments[0], arguments[1], arguments[2],
        arguments[3], arguments[4], arguments[5]
    );
}
