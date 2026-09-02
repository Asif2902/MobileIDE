#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

typedef long (*adev_syscall_fn)(long, ...);

static adev_syscall_fn adev_next_syscall;
static uid_t adev_uid;
static uid_t adev_euid;
static gid_t adev_gid;
static gid_t adev_egid;

__attribute__((constructor)) static void adev_linux_compat_init(void) {
    adev_next_syscall = (adev_syscall_fn)dlsym(RTLD_NEXT, "syscall");
    adev_uid = getuid();
    adev_euid = geteuid();
    adev_gid = getgid();
    adev_egid = getegid();
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
