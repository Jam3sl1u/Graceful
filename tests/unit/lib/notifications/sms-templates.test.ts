// Tests for lib/notifications/sms-templates.ts (#67). Exact-copy assertions
// transcribed from PRD §30 (doc lines 1698-1707), plus the <=160 property for
// every builder with maximum-length inputs (DB columns allow far longer free
// text than an SMS segment: role_note 500, reason 200, name 100).

import {
  SMS_MAX_LENGTH,
  setInvitationSms,
  memberReminderSms,
  adminReminderSms,
  invitationDeniedSms,
  schedulingConflictSms,
  setlistPublishedSms,
  practiceReminderSms,
  truncateField,
} from "@/lib/notifications/sms-templates";

const LINK = "https://example.com/i/abc123";

describe("SMS_MAX_LENGTH", () => {
  it("is 160", () => {
    expect(SMS_MAX_LENGTH).toBe(160);
  });
});

describe("setInvitationSms", () => {
  it("renders the PRD §30 copy with a roleNote", () => {
    expect(
      setInvitationSms({ date: "Aug 1, 2026", roleNote: "Worship Leader", link: LINK }),
    ).toBe(
      `Graceful: You're invited to lead worship on Aug 1, 2026. Role: Worship Leader. Respond here: ${LINK}`,
    );
  });

  it("omits ' Role: {roleNote}.' when roleNote is null, no double spaces", () => {
    const result = setInvitationSms({ date: "Aug 1, 2026", roleNote: null, link: LINK });
    expect(result).toBe(
      `Graceful: You're invited to lead worship on Aug 1, 2026. Respond here: ${LINK}`,
    );
    expect(result).not.toMatch(/ {2}/);
  });

  it("truncates a roleNote over 40 chars with an exact-length GSM-safe suffix", () => {
    const roleNote = "x".repeat(50);
    const result = setInvitationSms({ date: "Aug 1, 2026", roleNote, link: LINK });
    expect(result).toContain(`Role: ${"x".repeat(37)}...`);
  });

  it("stays within SMS_MAX_LENGTH with maximum-length inputs", () => {
    const result = setInvitationSms({
      date: "Aug 1, 2026",
      roleNote: "x".repeat(500),
      link: LINK,
    });
    expect(result.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });
});

describe("memberReminderSms", () => {
  it("renders the PRD §30 copy", () => {
    expect(memberReminderSms({ date: "Aug 1, 2026", link: LINK })).toBe(
      `Graceful: Reminder - your invitation for Aug 1, 2026 is still pending. Respond: ${LINK}`,
    );
  });

  it("stays within SMS_MAX_LENGTH", () => {
    const result = memberReminderSms({ date: "Aug 1, 2026", link: LINK });
    expect(result.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });
});

describe("adminReminderSms", () => {
  it("renders the PRD §30 copy", () => {
    expect(adminReminderSms({ count: 3, date: "Aug 1, 2026", link: LINK })).toBe(
      `Graceful: 3 invitation(s) for Aug 1, 2026 still awaiting response. View roster: ${LINK}`,
    );
  });

  it("renders '1 invitation(s)' verbatim for a count of 1 (no pluralization change)", () => {
    expect(adminReminderSms({ count: 1, date: "Aug 1, 2026", link: LINK })).toBe(
      `Graceful: 1 invitation(s) for Aug 1, 2026 still awaiting response. View roster: ${LINK}`,
    );
  });

  it("stays within SMS_MAX_LENGTH", () => {
    const result = adminReminderSms({ count: 25, date: "Aug 1, 2026", link: LINK });
    expect(result.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });
});

describe("invitationDeniedSms", () => {
  it("renders the PRD §30 copy with a reason", () => {
    expect(
      invitationDeniedSms({ memberName: "Jane Doe", date: "Aug 1, 2026", reason: "Sick", link: LINK }),
    ).toBe(`Graceful: Jane Doe can't make Aug 1, 2026. Reason: Sick. View roster: ${LINK}`);
  });

  it("omits ' Reason: {reason}.' when reason is null, no double spaces", () => {
    const result = invitationDeniedSms({
      memberName: "Jane Doe",
      date: "Aug 1, 2026",
      reason: null,
      link: LINK,
    });
    expect(result).toBe(`Graceful: Jane Doe can't make Aug 1, 2026. View roster: ${LINK}`);
    expect(result).not.toMatch(/ {2}/);
  });

  it("truncates memberName (40) and reason (60) exactly", () => {
    const memberName = "m".repeat(50);
    const reason = "r".repeat(70);
    const result = invitationDeniedSms({ memberName, date: "Aug 1, 2026", reason, link: LINK });
    expect(result).toContain(`${"m".repeat(37)}...`);
    expect(result.endsWith(LINK)).toBe(true);
  });

  it("stays within SMS_MAX_LENGTH with maximum-length inputs", () => {
    const result = invitationDeniedSms({
      memberName: "m".repeat(100),
      date: "Aug 1, 2026",
      reason: "r".repeat(200),
      link: LINK,
    });
    expect(result.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });
});

describe("schedulingConflictSms", () => {
  it("renders the PRD §30 copy", () => {
    expect(
      schedulingConflictSms({ memberName: "Jane Doe", date: "Aug 1, 2026", link: LINK }),
    ).toBe(`Graceful: CONFLICT - Jane Doe is now unavailable for Aug 1, 2026. View: ${LINK}`);
  });

  it("truncates memberName over 40 chars with '...'", () => {
    const memberName = "m".repeat(50);
    const result = schedulingConflictSms({ memberName, date: "Aug 1, 2026", link: LINK });
    expect(result).toContain(`${"m".repeat(37)}...`);
  });

  it("stays within SMS_MAX_LENGTH with maximum-length inputs", () => {
    const result = schedulingConflictSms({
      memberName: "m".repeat(100),
      date: "Aug 1, 2026",
      link: LINK,
    });
    expect(result.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });
});

describe("setlistPublishedSms", () => {
  it("renders the PRD §30 copy", () => {
    expect(setlistPublishedSms({ date: "Aug 1, 2026", link: LINK })).toBe(
      `Graceful: The setlist for Aug 1, 2026 is live. View it here: ${LINK}`,
    );
  });

  it("stays within SMS_MAX_LENGTH", () => {
    const result = setlistPublishedSms({ date: "Aug 1, 2026", link: LINK });
    expect(result.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });
});

describe("practiceReminderSms", () => {
  it("renders the PRD §30 copy with a location", () => {
    expect(
      practiceReminderSms({
        eventName: "Full Band Rehearsal",
        when: "tomorrow",
        time: "7:00 PM",
        location: "Main Hall",
      }),
    ).toBe("Graceful: Full Band Rehearsal is tomorrow at 7:00 PM - Main Hall");
  });

  it("omits the location separator when location is null", () => {
    const result = practiceReminderSms({
      eventName: "Full Band Rehearsal",
      when: "tomorrow",
      time: "7:00 PM",
      location: null,
    });
    expect(result).toBe("Graceful: Full Band Rehearsal is tomorrow at 7:00 PM");
    expect(result).not.toMatch(/-\s*$/);
    expect(result).not.toMatch(/ {2}/);
  });

  it("truncates eventName (40) and location (40) with '...'", () => {
    const eventName = "e".repeat(50);
    const location = "l".repeat(50);
    const result = practiceReminderSms({ eventName, when: "tomorrow", time: "7:00 PM", location });
    expect(result).toContain(`${"e".repeat(37)}...`);
    expect(result).toContain(`${"l".repeat(37)}...`);
  });

  it("stays within SMS_MAX_LENGTH with maximum-length inputs", () => {
    const result = practiceReminderSms({
      eventName: "e".repeat(40),
      when: "this coming Sunday morning",
      time: "10:00 AM",
      location: "l".repeat(40),
    });
    expect(result.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
  });
});

describe("SMS safety invariants", () => {
  const longLink = `https://graceful.example.com/invitations/${"x".repeat(44)}`;

  it.each([
    setInvitationSms({ date: "September 2026 service week", roleNote: "r".repeat(500), link: longLink }),
    memberReminderSms({ date: "September 2026 service week", link: longLink }),
    adminReminderSms({ count: 99, date: "September 2026 service week", link: longLink }),
    invitationDeniedSms({ memberName: "m".repeat(100), date: "September 2026 service week", reason: "r".repeat(200), link: longLink }),
    schedulingConflictSms({ memberName: "m".repeat(100), date: "September 2026 service week", link: longLink }),
    setlistPublishedSms({ date: "September 2026 service week", link: longLink }),
  ])("keeps a complete terminal link within one segment", (sms) => {
    expect(sms.length).toBeLessThanOrEqual(SMS_MAX_LENGTH);
    expect(sms.endsWith(longLink)).toBe(true);
  });

  it("keeps template output ASCII-only and field truncation exactly bounded", () => {
    const outputs = [
      setInvitationSms({ date: "Aug 1", roleNote: "x".repeat(50), link: LINK }),
      memberReminderSms({ date: "Aug 1", link: LINK }),
      adminReminderSms({ count: 1, date: "Aug 1", link: LINK }),
      invitationDeniedSms({ memberName: "x".repeat(50), date: "Aug 1", reason: "x".repeat(70), link: LINK }),
      schedulingConflictSms({ memberName: "x".repeat(50), date: "Aug 1", link: LINK }),
      setlistPublishedSms({ date: "Aug 1", link: LINK }),
      practiceReminderSms({ eventName: "x".repeat(50), when: "today", time: "7 PM", location: "x".repeat(50) }),
    ];
    expect(outputs.every((sms) => /^[\x00-\x7F]*$/.test(sms))).toBe(true);
    expect(truncateField("x".repeat(50), 40)).toHaveLength(40);
  });
});
