import {
  isReminderDue,
  buildMemberReminderSms,
  formatWeekLabel,
  REMINDER_INTERVAL_MS,
} from "@/lib/scheduling/reminder";

const NOW = new Date("2026-07-13T12:00:00.000Z");

function hoursBefore(hours: number, base: Date = NOW): string {
  return new Date(base.getTime() - hours * 60 * 60 * 1000).toISOString();
}

describe("isReminderDue", () => {
  it("is due when pending, lastRemindedAt is null, and createdAt is exactly 24h before now", () => {
    const invitation = {
      status: "pending",
      createdAt: hoursBefore(24),
      lastRemindedAt: null,
    };
    expect(isReminderDue(invitation, NOW)).toBe(true);
  });

  it("is not due when pending and createdAt is 23h59m before now (just under threshold)", () => {
    const invitation = {
      status: "pending",
      createdAt: new Date(NOW.getTime() - (REMINDER_INTERVAL_MS - 60 * 1000)).toISOString(),
      lastRemindedAt: null,
    };
    expect(isReminderDue(invitation, NOW)).toBe(false);
  });

  it("is due when pending and createdAt is 25h before now", () => {
    const invitation = {
      status: "pending",
      createdAt: hoursBefore(25),
      lastRemindedAt: null,
    };
    expect(isReminderDue(invitation, NOW)).toBe(true);
  });

  it("is not due when pending and lastRemindedAt is 2h before now (created days ago)", () => {
    const invitation = {
      status: "pending",
      createdAt: hoursBefore(24 * 10),
      lastRemindedAt: hoursBefore(2),
    };
    expect(isReminderDue(invitation, NOW)).toBe(false);
  });

  it("is due (repeat) when pending and lastRemindedAt is 24h+ before now", () => {
    const invitation = {
      status: "pending",
      createdAt: hoursBefore(24 * 10),
      lastRemindedAt: hoursBefore(24),
    };
    expect(isReminderDue(invitation, NOW)).toBe(true);
  });

  it.each(["accepted", "denied", "withdrawn"])(
    "is never due for a non-pending invitation (%s), even with an ancient createdAt (D1 automatic cancellation)",
    (status) => {
      const invitation = {
        status,
        createdAt: hoursBefore(24 * 365),
        lastRemindedAt: null,
      };
      expect(isReminderDue(invitation, NOW)).toBe(false);
    },
  );
});

describe("buildMemberReminderSms", () => {
  it("contains the member name and week label", () => {
    const sms = buildMemberReminderSms("Jane Doe", "Aug 01, 2026");
    expect(sms).toContain("Jane Doe");
    expect(sms).toContain("Aug 01, 2026");
  });
});

describe("formatWeekLabel", () => {
  it("uses the title when present", () => {
    expect(formatWeekLabel("Youth Sunday", "2026-08-01")).toBe("Youth Sunday");
  });

  it("uses a formatted serviceDate when title is null", () => {
    expect(formatWeekLabel(null, "2026-08-01")).toBe("Aug 01, 2026");
  });
});
