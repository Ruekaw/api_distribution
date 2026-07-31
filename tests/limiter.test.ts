import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { hashFor, limiterInput } from "./helpers";

function stub() {
  return env.PROXY_LIMITER.getByName("global");
}

describe("SQLite Durable Object limiter", () => {
  it("enforces RPM and resets at the next UTC minute", async () => {
    const limiter = stub();
    const nowMs = Date.parse("2026-08-01T00:00:30.000Z");
    for (let index = 0; index < 10; index += 1) {
      const result = await limiter.acquire(
        limiterInput(hashFor(1), { nowMs, maxConcurrency: 20 }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) await limiter.release(result.leaseId);
    }

    const blocked = await limiter.acquire(
      limiterInput(hashFor(1), { nowMs, maxConcurrency: 20 }),
    );
    expect(blocked).toMatchObject({
      ok: false,
      code: "per_ip_rpm_limit",
      retryAfterSeconds: 30,
    });

    const nextMinute = await limiter.acquire(
      limiterInput(hashFor(1), {
        nowMs: Date.parse("2026-08-01T00:01:00.000Z"),
        maxConcurrency: 20,
      }),
    );
    expect(nextMinute.ok).toBe(true);
  });

  it("does not charge one IP more than one hourly admission", async () => {
    const limiter = stub();
    const nowMs = Date.parse("2026-08-01T00:10:00.000Z");
    for (let index = 0; index < 3; index += 1) {
      const result = await limiter.acquire(
        limiterInput(hashFor(1), { nowMs, maxConcurrency: 10 }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) await limiter.release(result.leaseId);
    }
    const status = await limiter.getStatus(nowMs);
    expect(status.hourlyAdmissionCount).toBe(1);
  });

  it("admits ten hourly IPs, rejects the eleventh, and keeps admitted IPs usable", async () => {
    const limiter = stub();
    const nowMs = Date.parse("2026-08-01T00:10:00.000Z");
    for (let index = 1; index <= 10; index += 1) {
      const result = await limiter.acquire(
        limiterInput(hashFor(index), {
          nowMs,
          maxConcurrency: 20,
          perIpRpmLimit: 20,
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) await limiter.release(result.leaseId);
    }

    const eleventh = await limiter.acquire(
      limiterInput(hashFor(11), {
        nowMs,
        maxConcurrency: 20,
        perIpRpmLimit: 20,
      }),
    );
    expect(eleventh).toMatchObject({
      ok: false,
      code: "hourly_unique_ip_limit",
      retryAfterSeconds: 3_000,
    });

    const admittedAgain = await limiter.acquire(
      limiterInput(hashFor(1), {
        nowMs,
        maxConcurrency: 20,
        perIpRpmLimit: 20,
      }),
    );
    expect(admittedAgain.ok).toBe(true);
    const status = await limiter.getStatus(nowMs);
    expect(status.globalUsage[0]?.requestCount).toBe(11);
  });

  it("resets hourly admissions naturally at the next UTC hour", async () => {
    const limiter = stub();
    const before = Date.parse("2026-08-01T00:59:59.000Z");
    const first = await limiter.acquire(
      limiterInput(hashFor(1), {
        nowMs: before,
        hourlyUniqueIpLimit: 1,
      }),
    );
    expect(first.ok).toBe(true);
    if (first.ok) await limiter.release(first.leaseId);

    const blocked = await limiter.acquire(
      limiterInput(hashFor(2), {
        nowMs: before,
        hourlyUniqueIpLimit: 1,
      }),
    );
    expect(blocked.ok).toBe(false);

    const after = await limiter.acquire(
      limiterInput(hashFor(2), {
        nowMs: Date.parse("2026-08-01T01:00:00.000Z"),
        hourlyUniqueIpLimit: 1,
      }),
    );
    expect(after.ok).toBe(true);
  });

  it("atomically admits only one contender for the final hourly slot", async () => {
    const limiter = stub();
    const nowMs = Date.parse("2026-08-01T00:10:00.000Z");
    for (let index = 1; index <= 9; index += 1) {
      const result = await limiter.acquire(
        limiterInput(hashFor(index), {
          nowMs,
          maxConcurrency: 20,
        }),
      );
      if (result.ok) await limiter.release(result.leaseId);
    }
    const contenders = await Promise.all([
      limiter.acquire(
        limiterInput(hashFor(10), { nowMs, maxConcurrency: 20 }),
      ),
      limiter.acquire(
        limiterInput(hashFor(11), { nowMs, maxConcurrency: 20 }),
      ),
    ]);
    expect(contenders.filter((result) => result.ok)).toHaveLength(1);
    expect(
      contenders.filter(
        (result) => !result.ok && result.code === "hourly_unique_ip_limit",
      ),
    ).toHaveLength(1);
  });

  it("uses QUOTA_SCOPE for atomic global limits and retains old scope data", async () => {
    const limiter = stub();
    const base = {
      globalRequestLimit: 2,
      maxConcurrency: 10,
      hourlyUniqueIpLimit: 10,
    };
    for (let index = 1; index <= 2; index += 1) {
      const result = await limiter.acquire(
        limiterInput(hashFor(index), { ...base, quotaScope: "scope-a" }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) await limiter.release(result.leaseId);
    }
    const blocked = await limiter.acquire(
      limiterInput(hashFor(3), { ...base, quotaScope: "scope-a" }),
    );
    expect(blocked).toEqual({
      ok: false,
      code: "global_request_limit",
    });
    expect("retryAfterSeconds" in blocked).toBe(false);

    const newScope = await limiter.acquire(
      limiterInput(hashFor(3), { ...base, quotaScope: "scope-b" }),
    );
    expect(newScope.ok).toBe(true);
    const status = await limiter.getStatus();
    expect(status.globalUsage).toEqual([
      { scope: "scope-a", requestCount: 2 },
      { scope: "scope-b", requestCount: 1 },
    ]);
  });

  it("atomically allows only one contender for the final global call", async () => {
    const limiter = stub();
    const contenders = await Promise.all([
      limiter.acquire(
        limiterInput(hashFor(1), {
          globalRequestLimit: 1,
          maxConcurrency: 10,
        }),
      ),
      limiter.acquire(
        limiterInput(hashFor(2), {
          globalRequestLimit: 1,
          maxConcurrency: 10,
        }),
      ),
    ]);
    expect(contenders.filter((result) => result.ok)).toHaveLength(1);
    expect(
      contenders.filter(
        (result) => !result.ok && result.code === "global_request_limit",
      ),
    ).toHaveLength(1);
    expect((await limiter.getStatus()).globalUsage[0]?.requestCount).toBe(1);
  });

  it("enforces concurrency, rolls back rejected counters, and releases idempotently", async () => {
    const limiter = stub();
    const leases: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
      const result = await limiter.acquire(
        limiterInput(hashFor(index), { maxConcurrency: 3 }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) leases.push(result.leaseId);
    }
    const fourth = await limiter.acquire(
      limiterInput(hashFor(4), { maxConcurrency: 3 }),
    );
    expect(fourth).toEqual({
      ok: false,
      code: "max_concurrency",
      retryAfterSeconds: 10,
    });
    expect((await limiter.getStatus()).globalUsage[0]?.requestCount).toBe(3);

    expect(await limiter.release(leases[0]!)).toBe(true);
    expect(await limiter.release(leases[0]!)).toBe(false);
    const retry = await limiter.acquire(
      limiterInput(hashFor(4), { maxConcurrency: 3 }),
    );
    expect(retry.ok).toBe(true);
  });

  it("atomically allows one contender for the final lease", async () => {
    const limiter = stub();
    for (let index = 1; index <= 2; index += 1) {
      await limiter.acquire(
        limiterInput(hashFor(index), { maxConcurrency: 3 }),
      );
    }
    const contenders = await Promise.all([
      limiter.acquire(
        limiterInput(hashFor(3), { maxConcurrency: 3 }),
      ),
      limiter.acquire(
        limiterInput(hashFor(4), { maxConcurrency: 3 }),
      ),
    ]);
    expect(contenders.filter((result) => result.ok)).toHaveLength(1);
    expect(
      contenders.filter(
        (result) => !result.ok && result.code === "max_concurrency",
      ),
    ).toHaveLength(1);
  });

  it("renews a live lease and refuses to resurrect a missing lease", async () => {
    const limiter = stub();
    const started = Date.now();
    const result = await limiter.acquire(
      limiterInput(hashFor(1), {
        nowMs: started,
        leaseTtlSeconds: 2,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await limiter.renew(result.leaseId, 2)).toBe(true);
    expect((await limiter.getStatus(started + 2_500)).activeLeaseCount).toBe(1);
    expect(await limiter.renew(crypto.randomUUID(), 2)).toBe(false);
  });

  it("reclaims expired leases after heartbeat stops and cleans old buckets", async () => {
    const limiter = stub();
    const oldTime = Date.parse("2026-08-01T00:00:00.000Z");
    const old = await limiter.acquire(
      limiterInput(hashFor(1), {
        nowMs: oldTime,
        leaseTtlSeconds: 2,
        maxConcurrency: 1,
      }),
    );
    expect(old.ok).toBe(true);
    expect((await limiter.getStatus(oldTime + 2_001)).activeLeaseCount).toBe(0);

    const future = oldTime + 55 * 60 * 60 * 1000;
    const replacement = await limiter.acquire(
      limiterInput(hashFor(2), {
        nowMs: future,
        leaseTtlSeconds: 2,
        maxConcurrency: 1,
      }),
    );
    expect(replacement.ok).toBe(true);
    const status = await limiter.getStatus(future);
    expect(status.totalLeaseCount).toBe(1);
    expect(status.minuteUsageCount).toBe(1);
    expect(status.hourlyAdmissionCount).toBe(1);
  });
});
