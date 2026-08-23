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

#ifdef __cplusplus
}
#endif

#endif  /* ADEV_RUNTIME_ENV_H */
