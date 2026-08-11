const DEFAULT_REPOSITORY_NAME = 'cloned-repository';

/**
 * Return a filesystem-safe project name for the app-private workspace root.
 * Clone destinations are deliberately one directory below /root/workspaces so
 * every cloned repository is discoverable by the Projects picker.
 */
export function normalizeProjectFolderName(value: string): string {
  const normalized = value
    .trim()
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    // Native GitPolicy requires the first character to be alphanumeric.
    // Strip leading underscores as well as dots/hyphens so the destination
    // shown by the UI is exactly the folder the Android bridge will accept.
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[.-]+$/g, '')
    .slice(0, 96);

  return normalized && normalized !== '.' && normalized !== '..'
    ? normalized
    : DEFAULT_REPOSITORY_NAME;
}

/** Supports HTTPS, ssh:// and SCP-style Git URLs. */
export function repositoryNameFromUrl(url: string): string {
  const withoutQuery = url.trim().split(/[?#]/, 1)[0].replace(/[\\/]+$/, '');
  const tail = withoutQuery.split(/[\\/:]/).pop() || DEFAULT_REPOSITORY_NAME;
  let decoded = tail;
  try {
    decoded = decodeURIComponent(tail);
  } catch {
    // Keep the original text if it is not valid percent-encoding.
  }
  return normalizeProjectFolderName(decoded);
}

export function privateCloneDestination(workspacesRoot: string, folder: string): string {
  const root = workspacesRoot.trim().replace(/[\\/]+$/, '');
  if (!root) {
    throw new Error('Private workspace root is unavailable');
  }
  return `${root}/${normalizeProjectFolderName(folder)}`;
}
