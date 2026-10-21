export function parseAllowedLastfmUsernames(): Set<string> {
  const raw = process.env.ALLOWED_LASTFM_USERNAMES;
  if (!raw?.trim()) {
    return new Set();
  }
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isLastfmUsernameOnWhitelist(username: string): boolean {
  const allowed = parseAllowedLastfmUsernames();
  if (allowed.size === 0) {
    return false;
  }
  return allowed.has(username.trim().toLowerCase());
}

export function parseAllowedCurrentYearLastfmUsernames(): Set<string> {
  const raw = process.env.SYSTEM_MANAGER_ACCOUNT;
  if (!raw?.trim()) {
    return new Set();
  }
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isLastfmUsernameAllowedCurrentYear(username: string): boolean {
  const allowed = parseAllowedCurrentYearLastfmUsernames();
  if (allowed.size === 0) {
    return false;
  }
  return allowed.has(username.trim().toLowerCase());
}
