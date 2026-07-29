#ifndef LIBTERMUX_CORE__NOS__C__UNIX_FORK_UTILS___H
#define LIBTERMUX_CORE__NOS__C__UNIX_FORK_UTILS___H

#include <signal.h>

#ifdef __cplusplus
extern "C" {
#endif


typedef struct sForkInfo ForkInfo;

struct sForkInfo {
    bool isChild;
    int cpid;
    int exitCode;
    int status;
    int stdoutFd; // Original stdout fd of child.
    int stderrFd; // Original stderr fd of child.
    int pipeFds[2]; // Fd used for child to send stdout/stderr to parent.
    FILE *pipeFile;
    char *output;
    bool returnOutput;
    bool redirectChildStdinToDevNull;
    bool redirectChildStdoutToDevNull;
    bool redirectChildStderrToDevNull;
    size_t outputInitialBuffer;
    const char* parentLogTag;
    const char* childLogTag;
    void (*onChildFork)(ForkInfo *info);
};

#define INIT_FORK_INFO(X) ForkInfo X = { \
    .cpid = -1, \
    .exitCode = -1, \
    .stdoutFd = -1, \
    .stderrFd = -1, \
    .pipeFile = NULL, \
    .output = NULL, \
    .returnOutput = true, \
    .outputInitialBuffer = 255, \
    .parentLogTag = NULL, .childLogTag = NULL, \
    .onChildFork = NULL \
}



int forkChild(ForkInfo *info);
void exitForkWithError(ForkInfo *info, int exitCode);
void cleanupFork(ForkInfo *info);



#ifdef __cplusplus
}
#endif

#endif // LIBTERMUX_CORE__NOS__C__UNIX_FORK_UTILS___H
