#ifndef LIBTERMUX_CORE__NOS__C__TERMUX_CORE_LIBRARY_CONFIG___H
#define LIBTERMUX_CORE__NOS__C__TERMUX_CORE_LIBRARY_CONFIG___H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif



/** Get `sIsRunningTests`. */
bool libtermux_core__nos__c__getIsRunningTests();

/** Set `sIsRunningTests`. */
void libtermux_core__nos__c__setIsRunningTests(bool isRunningTests);



#ifdef __cplusplus
}
#endif

#endif // LIBTERMUX_CORE__NOS__C__TERMUX_CORE_LIBRARY_CONFIG___H
