interface Attempt {
  count: number;
  resetAt: number;
}

/** In-memory fixed-window counter for failed logins, keyed by account email. */
export class LoginLimiter {
  private readonly attempts = new Map<string, Attempt>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  isBlocked(key: string): boolean {
    const attempt = this.current(key);
    return attempt !== undefined && attempt.count >= this.maxAttempts;
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
