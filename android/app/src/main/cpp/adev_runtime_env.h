#ifndef ADEV_RUNTIME_ENV_H
#define ADEV_RUNTIME_ENV_H

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Restore A Dev Studio's runtime environment contract in the current process.
 *
 * Reads the contract published by AdevEnvironment (`<runtime>/etc/adev-env.conf`)
 * and fills in only what this process is missing, plus anything still addressed
 * to a Termux installation that does not exist here. Values a caller
 * deliberately set are preserved. PATH is merged rather than replaced.
 *
 * The runtime root is discovered at run time — from the environment when it
 * survived, otherwise from this executable's own location — so no `/data/app`
 * install identifier is ever assumed. Safe to call more than once; the work is
 * done at most once per process.
 */
void adev_runtime_env_apply(void);

/**
 * Environment block prepared for an exec-family call.
 *
 * `values` either borrows the caller's block or owns a repaired copy. Call
 * [adev_runtime_env_release_exec] on every path where exec returns.
 */
typedef struct {
    char **values;
    int owned;
} adev_runtime_exec_env;

/**
 * Repair an Android/Bun-sanitized child environment from adev-env.conf.
 *
 * Existing caller values are preserved. PATH and LD_PRELOAD receive missing
 * contract entries ahead of the caller's entries, while stale Termux values
 * are replaced. Empty environments and ADEV_ENV_AUTOFILL=0 are deliberately
 * left untouched so `env -i` retains its standard meaning.
 */
int adev_runtime_env_prepare_exec(
    char *const envp[],
    adev_runtime_exec_env *prepared
);

void adev_runtime_env_release_exec(adev_runtime_exec_env *prepared);

#ifdef __cplusplus
}
#endif

#endif  /* ADEV_RUNTIME_ENV_H */
