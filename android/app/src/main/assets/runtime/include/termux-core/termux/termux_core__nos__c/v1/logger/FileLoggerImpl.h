#ifndef LIBTERMUX_CORE__NOS__C__FILE_LOGGER_IMPL___H
#define LIBTERMUX_CORE__NOS__C__FILE_LOGGER_IMPL___H

#include <stdbool.h>

#include <termux/termux_core__nos__c/v1/logger/Logger.h>

#ifdef __cplusplus
extern "C" {
#endif



extern const struct ILogger sFileLoggerImpl;

void printMessageToFile(bool logOnStderr, const char* message);

FILE* getLogFileStream();
const char* getLogFilePath();
int setLogFilePath(const char* logFilePath);
int closeLogFile();



#ifdef __cplusplus
}
#endif

#endif // LIBTERMUX_CORE__NOS__C__FILE_LOGGER_IMPL___H
