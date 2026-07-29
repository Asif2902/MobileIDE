#ifndef LIBTERMUX_EXEC__NOS__C__TERMUX_EXEC_PROCESS___H
#define LIBTERMUX_EXEC__NOS__C__TERMUX_EXEC_PROCESS___H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif



int termuxExec_process_initProcess(const char *versionToLog, const char *logFilePath);
int termuxExec_process_initLogger(const char *versionToLog, const char *logFilePath);
void termuxExec_process_setIgnoreExit(bool state);
int termuxExec_process_exitProcess();



#ifdef __cplusplus
}
#endif

#endif // LIBTERMUX_EXEC__NOS__C__TERMUX_EXEC_PROCESS___H
