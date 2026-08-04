// Tests for lib/resend/templates.ts (#68) — verifies the 7 PRD §30 email
// templates render the exact copy, escape untrusted HTML, and handle the
// documented edge cases.

import { renderEmailTemplate, EMAIL_TEMPLATE_KEYS } from "@/lib/resend/templates";

describe("renderEmailTemplate", () => {
  it("set_invitation renders the exact PRD subject and preview with a link", () => {
    const result = renderEmailTemplate("set_invitation", {
      date: "Aug 09, 2026",
      adminName: "Pat Admin",
      link: "https://graceful.app/invitations/1",
    });

    expect(result.subject).toBe("You're invited to lead worship on Aug 09, 2026");
    expect(result.preview).toBe("Pat Admin has selected you for Aug 09, 2026. Tap to accept or decline.");
    expect(result.html).toBe(
      "<!doctype html><html><body>" +
        '<div style="display:none;max-height:0;overflow:hidden;">Pat Admin has selected you for Aug 09, 2026. Tap to accept or decline.</div>' +
        "<h1>You&#39;re invited to lead worship on Aug 09, 2026</h1>" +
        "<p>Pat Admin has selected you for Aug 09, 2026. Tap to accept or decline.</p>" +
        '<p><a href="https://graceful.app/invitations/1">Open Graceful</a></p>' +
        "</body></html>",
    );
    expect(result.text).toBe(
      "You're invited to lead worship on Aug 09, 2026\n\n" +
        "Pat Admin has selected you for Aug 09, 2026. Tap to accept or decline.\n\n" +
        "https://graceful.app/invitations/1",
    );
  });

  it("invitation_reminder_member renders the exact PRD subject and preview", () => {
    const result = renderEmailTemplate("invitation_reminder_member", {
      date: "Aug 09, 2026",
      link: "https://graceful.app/invitations/1",
    });

    expect(result.subject).toBe("Your invitation for Aug 09, 2026 needs a response");
    expect(result.preview).toBe("You haven't responded yet. Please accept or decline.");
  });

  it("invitation_reminder_admin renders count as given and joins member names", () => {
    const result = renderEmailTemplate("invitation_reminder_admin", {
      count: 3,
      date: "Aug 09, 2026",
      memberNames: ["Jane", "Sam", "Alex"],
      link: "https://graceful.app/admin",
    });

    expect(result.subject).toBe("3 unanswered invitations for Aug 09, 2026");
    expect(result.preview).toBe("The following members haven't responded: Jane, Sam, Alex");
  });

  it("invitation_reminder_admin uses the given count even if it doesn't match memberNames.length", () => {
    const result = renderEmailTemplate("invitation_reminder_admin", {
      count: 99,
      date: "Aug 09, 2026",
      memberNames: ["Jane"],
      link: "https://graceful.app/admin",
    });

    expect(result.subject).toBe("99 unanswered invitations for Aug 09, 2026");
  });

  it("invitation_reminder_admin throws when memberNames is empty", () => {
    expect(() =>
      renderEmailTemplate("invitation_reminder_admin", {
        count: 0,
        date: "Aug 09, 2026",
        memberNames: [],
        link: "https://graceful.app/admin",
      }),
    ).toThrow("invitation_reminder_admin requires at least one member name");
  });

  it("invitation_denied renders the reason clause when a reason is given", () => {
    const result = renderEmailTemplate("invitation_denied", {
      memberName: "Jane",
      date: "Aug 09, 2026",
      reason: "Out of town",
      link: "https://graceful.app/invitations/1",
    });

    expect(result.subject).toBe("Jane declined for Aug 09, 2026");
    expect(result.preview).toBe("Reason: Out of town. Open Graceful to find a replacement.");
  });

  it("invitation_denied drops the reason clause when reason is null", () => {
    const result = renderEmailTemplate("invitation_denied", {
      memberName: "Jane",
      date: "Aug 09, 2026",
      reason: null,
      link: "https://graceful.app/invitations/1",
    });

    expect(result.preview).toBe("Open Graceful to find a replacement.");
  });

  it("invitation_denied drops the reason clause when reason is whitespace-only", () => {
    const result = renderEmailTemplate("invitation_denied", {
      memberName: "Jane",
      date: "Aug 09, 2026",
      reason: "   ",
      link: "https://graceful.app/invitations/1",
    });

    expect(result.preview).toBe("Open Graceful to find a replacement.");
  });

  it("scheduling_conflict renders the exact PRD subject and preview", () => {
    const result = renderEmailTemplate("scheduling_conflict", {
      memberName: "Jane",
      date: "Aug 09, 2026",
      link: "https://graceful.app/conflicts/1",
    });

    expect(result.subject).toBe("Scheduling conflict for Aug 09, 2026");
    expect(result.preview).toBe(
      "Jane changed their availability after confirming. Action may be needed.",
    );
  });

  it("setlist_released renders the exact PRD subject and preview", () => {
    const result = renderEmailTemplate("setlist_released", {
      date: "Aug 09, 2026",
      songCount: 5,
      link: "https://graceful.app/setlists/1",
    });

    expect(result.subject).toBe("Setlist for Aug 09, 2026 is ready");
    expect(result.preview).toBe(
      "5 songs planned. Open Graceful to see the full setlist and your chord charts.",
    );
  });

  it("practice_reminder renders the exact PRD subject and preview, including the em dash", () => {
    const result = renderEmailTemplate("practice_reminder", {
      eventName: "Sunday Rehearsal",
      hoursUntil: 2,
      dayDate: "Sun, Aug 09",
      time: "9:00 AM",
      location: "Main hall",
      link: "https://graceful.app/events/1",
    });

    expect(result.subject).toBe("Reminder: Sunday Rehearsal in 2 hours");
    expect(result.preview).toBe("Sun, Aug 09 at 9:00 AM — Main hall. See you there.");
  });

  it("practice_reminder without a link omits the <a> element and the trailing URL line", () => {
    const result = renderEmailTemplate("practice_reminder", {
      eventName: "Sunday Rehearsal",
      hoursUntil: 2,
      dayDate: "Sun, Aug 09",
      time: "9:00 AM",
      location: "Main hall",
    });

    expect(result.html).not.toContain("<a href");
    expect(result.html).toBe(
      "<!doctype html><html><body>" +
        '<div style="display:none;max-height:0;overflow:hidden;">Sun, Aug 09 at 9:00 AM — Main hall. See you there.</div>' +
        "<h1>Reminder: Sunday Rehearsal in 2 hours</h1>" +
        "<p>Sun, Aug 09 at 9:00 AM — Main hall. See you there.</p>" +
        "</body></html>",
    );
    expect(result.text).toBe(
      "Reminder: Sunday Rehearsal in 2 hours\n\nSun, Aug 09 at 9:00 AM — Main hall. See you there.",
    );
  });

  it("escapes HTML special characters in interpolated values within html but not within text/subject/preview", () => {
    const result = renderEmailTemplate("invitation_denied", {
      memberName: '<script>alert("x")</script> & Co',
      date: "Aug 09, 2026",
      reason: null,
      link: "https://graceful.app/invitations/1?a=1&b=2",
    });

    expect(result.html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co declined for Aug 09, 2026",
    );
    expect(result.html).not.toContain("<script>alert");
    expect(result.html).toContain('href="https://graceful.app/invitations/1?a=1&amp;b=2"');

    // subject/preview on the returned object, and text, are unescaped.
    expect(result.subject).toBe('<script>alert("x")</script> & Co declined for Aug 09, 2026');
    expect(result.text).toContain('<script>alert("x")</script> & Co declined for Aug 09, 2026');
  });

  it("throws on an unknown template key", () => {
    expect(() =>
      renderEmailTemplate(
        // @ts-expect-error deliberately invalid key to exercise the untyped-caller guard
        "not_a_real_key",
        {},
      ),
    ).toThrow("Unknown email template: not_a_real_key");
  });

  it("exports exactly the 7 PRD §30 template keys", () => {
    expect(EMAIL_TEMPLATE_KEYS).toEqual([
      "set_invitation",
      "invitation_reminder_member",
      "invitation_reminder_admin",
      "invitation_denied",
      "scheduling_conflict",
      "setlist_released",
      "practice_reminder",
    ]);
  });
});
