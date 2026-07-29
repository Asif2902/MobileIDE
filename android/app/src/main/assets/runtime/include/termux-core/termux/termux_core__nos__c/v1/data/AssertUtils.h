#ifndef LIBTERMUX_CORE__NOS__C__ASSERT_UTILS___H
#define LIBTERMUX_CORE__NOS__C__ASSERT_UTILS___H

#include <stdbool.h>

#include <termux/termux_core__nos__c/v1/logger/Logger.h>

#ifdef __cplusplus
extern "C" {
#endif



void assertBoolWithError(bool expected, bool actual, const char* logTag, const char *fmt, ...);
void assertBool(bool expected, bool actual, const char* logTag);



void assertTrueWithError(bool actual, const char* logTag, const char *error_fmt, ...);
void assertTrue(bool actual, const char* logTag);



void assertFalseWithError(bool actual, const char* logTag, const char *fmt, ...);
void assertFalse(bool actual, const char* logTag);





void assertIntWithError(int expected, int actual, const char* logTag, const char *fmt, ...);
void assertInt(int expected, int actual, const char* logTag);





bool stringEqualsRegardingNull(const char *expected, const char *actual);

void assertStringEqualsWithError(const char *expected, const char *actual,
    const char* logTag, const char *fmt, ...);
void assertStringEquals(const char *expected, const char *actual, const char* logTag);



void assertStringNullWithError(const char *actual, const char* logTag, const char *fmt, ...);
void assertStringNull(const char *actual, const char* logTag);



void assertStringNotNullWithError(const char *actual, const char* logTag, const char *fmt, ...);
void assertStringNotNull(const char *actual, const char* logTag);





#define state__ATrue(state)                                                                        \
    if (1) {                                                                                       \
    assertTrueWithError(state,                                                                     \
        LOG_TAG, "%d: %s() -> (%s)", __LINE__, __FUNCTION__, #state);                              \
    } else ((void)0)

#define int__AEqual(expected, actual)                                                              \
    if (1) {                                                                                       \
    assertIntWithError(expected, actual,                                                           \
        LOG_TAG, "%d: %s()", __LINE__, __FUNCTION__);                                              \
    } else ((void)0)

#define string__AEqual(expected, actual)                                                           \
    if (1) {                                                                                       \
    assertStringEqualsWithError(expected, actual,                                                  \
        LOG_TAG, "%d: %s()", __LINE__, __FUNCTION__);                                              \
    } else ((void)0)



#ifdef __cplusplus
}
#endif

#endif // LIBTERMUX_CORE__NOS__C__ASSERT_UTILS___H
