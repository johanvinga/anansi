import { describe, expect, it } from "vitest";
import { LoginLimiter } from "./login-limiter.js";

describe("LoginLimiter (FR-AUTH-06)", () => {
  it("blocks after the maximum number of failures", () => {
    const limiter = new LoginLimiter(2, 60_000);
    limiter.recordFailure("a@test.local");
    expect(limiter.isBlocked("a@test.local")).toBe(false);
    limiter.recordFailure("a@test.local");
    expect(limiter.isBlocked("a@test.local")).toBe(true);
    expect(limiter.isBlocked("b@test.local")).toBe(false);
  });

  it("clears the block after the window elapses", () => {
    let now = 0;
    const limiter = new LoginLimiter(1, 1000, () => now);
    limiter.recordFailure("a@test.local");
    expect(limiter.isBlocked("a@test.local")).toBe(true);
    now = 1000;
    expect(limiter.isBlocked("a@test.local")).toBe(false);
  });

  it("resets on successful login", () => {
    const limiter = new LoginLimiter(1, 60_000);
    limiter.recordFailure("a@test.local");
    limiter.reset("a@test.local");
    expect(limiter.isBlocked("a@test.local")).toBe(false);
  });

  it("limits simultaneous attempts and releases capacity afterward", () => {
    const limiter = new LoginLimiter(1, 60_000);
    expect(limiter.beginAttempt("a@test.local")).toBe(true);
    expect(limiter.beginAttempt("a@test.local")).toBe(false);
    limiter.finishAttempt("a@test.local");
    expect(limiter.beginAttempt("a@test.local")).toBe(true);
    limiter.recordFailure("a@test.local");
    limiter.finishAttempt("a@test.local");
    expect(limiter.beginAttempt("a@test.local")).toBe(false);
    expect(limiter.retryAfterSeconds("a@test.local")).toBeGreaterThan(0);
  });
});
