#ifndef LIBTERMUX_CORE__NOS__C__UNIX_SIGNAL_UTILS___H
#define LIBTERMUX_CORE__NOS__C__UNIX_SIGNAL_UTILS___H

#include <signal.h>

#ifdef __cplusplus
extern "C" {
#endif



/**
 * Set signal handler by calling `sigaction()`.
 *
 * - https://man7.org/linux/man-pages/man2/sigaction.2.html
 *
 * @return Return old `sigaction.sa_handler` on success, otherwise `SIG_ERR`.
 */
sighandler_t setSignalHandler(const char* logTag,
    int signum, sighandler_t saHandler, sigset_t saMask, int saFlags);



#ifdef __cplusplus
}
#endif

#endif // LIBTERMUX_CORE__NOS__C__UNIX_SIGNAL_UTILS___H
