// The update reminder. Every 12 hours the server asks GitHub for the latest
// release (one anonymous GET of a public URL; nothing about the instance or
// its users is sent) and the app compares it with the version it is running.
// Browsers never contact GitHub themselves. UPDATE_CHECK=off turns it off.

export interface UpdateInfo {
  enabled: boolean;
  latest: string | null;
  url: string | null;
  checkedAt: number | null;
}

const TWELVE_HOURS = 12 * 3_600_000;

export class UpdateChecker {
  info: UpdateInfo;
  repo: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(enabled: boolean, repo: string) {
    this.repo = repo;
    this.info = { enabled, latest: null, url: null, checkedAt: null };
  }

  start() {
    if (!this.info.enabled) return;
    const run = () => this.check().catch(() => {});
    setTimeout(run, 30_000).unref();
    this.timer = setInterval(run, TWELVE_HOURS);
    this.timer.unref();
  }

  async check() {
    const res = await fetch(`https://api.github.com/repos/${this.repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "autotagarr-update-check" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return;
    const release = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    const tag = release.tag_name;
    const url = release.html_url;
    if (typeof tag !== "string" || !/^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(tag)) return;
    if (typeof url !== "string" || !url.startsWith("https://github.com/")) return;
    this.info = { ...this.info, latest: tag, url, checkedAt: Date.now() };
  }
}

/** True when `latest` is a newer release than `current` (dev builds never are). */
export function isNewer(latest: string | null, current: string): boolean {
  if (!latest) return false;
  const parse = (v: string) => {
    const m = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(-.+)?$/);
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? "" } : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
  }
  // Same numbers: a release beats its own pre-release.
  return b.pre !== "" && a.pre === "";
}
