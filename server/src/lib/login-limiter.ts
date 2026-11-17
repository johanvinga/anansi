interface Attempt {
  count: number;
  resetAt: number;
}

/** In-memory fixed-window counter for failed logins, keyed by account email. */
export class LoginLimiter {
  private readonly attempts = new Map<string, Attempt>();
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  isBlocked(key: string): boolean {
    const attempt = this.current(key);
    return attempt !== undefined && attempt.count >= this.maxAttempts;
  }

  retryAfterSeconds(key: string): number {
    const attempt = this.current(key);
    return attempt && attempt.count >= this.maxAttempts
      ? Math.max(1, Math.ceil((attempt.resetAt - this.now()) / 1000))
      : 0;
  }

  beginAttempt(key: string): boolean {
    const pending = this.pending.get(key) ?? 0;
    const failures = this.current(key)?.count ?? 0;
    if (failures + pending >= this.maxAttempts) return false;
    this.pending.set(key, pending + 1);
    return true;
  }

  finishAttempt(key: string): void {
    const pending = this.pending.get(key) ?? 0;
    if (pending <= 1) this.pending.delete(key);
    else this.pending.set(key, pending - 1);
  }

  recordFailure(key: string): void {
    const attempt = this.current(key);
    if (attempt) {
      attempt.count += 1;
    } else {
      this.attempts.set(key, { count: 1, resetAt: this.now() + this.windowMs });
    }
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  private current(key: string): Attempt | undefined {
    const attempt = this.attempts.get(key);
    if (attempt && attempt.resetAt <= this.now()) {
      this.attempts.delete(key);
      return undefined;
    }
    return attempt;
  }
}
