import test from "node:test";
import assert from "node:assert/strict";
import { createIcs, detectEvent, enrichEvent } from "../src/events.js";

const REFERENCE = "2026-09-03T10:00:00Z";

test("detects an English event with timezone and location", () => {
  const event = detectEvent({
    subject: "Engineering sync",
    body: "Meeting on September 10, 2026 at 2:30 PM BST\nLocation: Room 4",
    date: REFERENCE,
  });

  assert.equal(event.detected, true);
  assert.equal(event.startDate, "2026-09-10");
  assert.equal(event.startTime, "14:30");
  assert.equal(event.endTime, "15:00");
  assert.equal(event.durationSource, "inferred");
  assert.equal(event.timezoneOffsetMinutes, 60);
  assert.equal(event.location, "Room 4");
});

test("extracts flexible ranges and a physical location", () => {
  const event = detectEvent({
    subject: "Reminder: Q4 planning",
    body: "Please join us for the quarterly planning workshop on September 10, 2026 from 2 to 4 PM. The meeting will be held at The Shard, Level 12.",
    date: REFERENCE,
  });

  assert.equal(event.startTime, "14:00");
  assert.equal(event.endTime, "16:00");
  assert.equal(event.durationSource, "range");
  assert.equal(event.location, "The Shard, Level 12");
});

test("uses explicit duration and an online meeting link", () => {
  const event = detectEvent({
    subject: "Webinar invitation",
    body: "Security webinar on September 20 at 3 PM. Duration: 90 minutes. https://meet.google.com/abc-defg-hij",
    date: REFERENCE,
  });

  assert.equal(event.endTime, "16:30");
  assert.equal(event.durationMinutes, 90);
  assert.equal(event.durationSource, "explicit");
  assert.equal(event.location, "https://meet.google.com/abc-defg-hij");
});

test("extracts separately labelled start and end times", () => {
  const event = detectEvent({
    subject: "Design review",
    body: "Design review on September 18, 2026. Starts at 10 AM and ends at 11:15 AM via Microsoft Teams.",
    date: REFERENCE,
  });

  assert.equal(event.startTime, "10:00");
  assert.equal(event.endTime, "11:15");
  assert.equal(event.location, "Microsoft Teams");
  assert.equal(event.durationSource, "range");
});

test("extracts the meetup title, postal address, and complete agenda", async () => {
  const input = {
    subject: "You're attending: JSMonthly London September Meetup #210",
    date: "2026-09-08T10:59:18Z",
    body: [
      "You're confirmed for",
      "JSMonthly London September Meetup #210",
      "When",
      "September 24th from 6PM to 9PM",
      "Where",
      "7 Handyside St",
      "7 Handyside St, London N1C 4DA, UK",
      "https://www.google.com/maps/search/?api=1&query=7+Handyside+St",
      "Join us on Thursday, 24th September for our JS Monthly Meetup!",
      "We're meeting in person at the NewDay office.",
      "Location",
      "NewDay",
      "7 Handyside Street, London N1C 4DC",
      "Precise entrance/location:",
      "what3words - stick.span.again https://w3w.co/stick.span.again",
      "Rough timings",
      "6:00 - 6:30 PM: Doors open & refreshments",
      "6:30 - 6:40 PM: Welcome & introduction",
      "6:40 - 6:55 PM: Learnings from Building an AI Workflow Harness: From Jira Ticket",
      "to GitHub PR // Pablo Ventura",
      "6:55 - 7:25 PM: An Emulator's Journey Redux // Rob Bateman",
      "7:25 - 7:40 PM: Break",
      "7:40 - 8:20 PM: Smart Angular apps with Firebase AI Logic // Aristeidis Bampakos",
      "8:20 - 8:30 PM: Closing",
      "8:45 PM: We'll start heading to the pub",
      "9:00 PM: Venue close",
      "Want to give a talk? Submit your talk here",
      "https://example.com/talks",
    ].join("\n\n"),
  };
  const event = await enrichEvent(input, detectEvent(input));

  assert.equal(event.detected, true);
  assert.equal(event.startDate, "2026-09-24");
  assert.equal(event.startTime, "18:00");
  assert.equal(event.endTime, "21:00");
  assert.equal(
    event.location,
    "7 Handyside Street, London N1C 4DC",
  );
  assert.equal(event.title, "JSMonthly London September Meetup #210");
  assert.match(event.description, /^Agenda:\n6:00 - 6:30 PM:/);
  assert.match(event.description, /From Jira Ticket to GitHub PR \/\/ Pablo Ventura/);
  assert.match(event.description, /9:00 PM: Venue close$/);
  assert.equal(event.description.split("\n").length, 10);

  const modelAssisted = await enrichEvent(input, detectEvent(input), async () => ({
    title: "JS Monthly London Meetup",
    description: "Join us for tech talks and networking.",
  }));
  assert.match(modelAssisted.description, /^Agenda:\n/);
  assert.equal(modelAssisted.fieldSources.description, "rules");
});

test("model-assisted enrichment derives title and summary from the event text", async () => {
  const input = {
    subject: "Reminder 48291",
    body: "Please join us for the quarterly engineering planning workshop on September 10, 2026 at 14:00. The agenda covers staffing and release risks.",
    date: REFERENCE,
  };
  const detected = detectEvent(input);
  let receivedDetectedEvent;
  const enriched = await enrichEvent(input, detected, async (_input, event) => {
    receivedDetectedEvent = event;
    return {
      title: "Quarterly engineering planning",
      description: "The workshop covers staffing and release risks.",
      location: "Invented Room 4",
      durationMinutes: 15,
    };
  });

  assert.equal(receivedDetectedEvent, detected);
  assert.equal(enriched.title, "Quarterly engineering planning");
  assert.equal(enriched.description, "The workshop covers staffing and release risks.");
  assert.equal(enriched.location, "");
  assert.equal(enriched.endTime, "16:00");
  assert.equal(enriched.durationSource, "inferred");
  assert.notEqual(enriched.title, input.subject);
});

test("rejects footer-like or body-length model descriptions", async () => {
  const input = {
    subject: "Design review",
    body: "Design review on September 18, 2026 at 10:00. We will decide the launch scope.",
    date: REFERENCE,
  };
  const detected = detectEvent(input);
  const footer = "Kind regards. All rights reserved. View in browser or unsubscribe from this mailing list.";
  const enriched = await enrichEvent(input, detected, async () => ({
    title: "Launch Scope Review",
    description: footer,
  }));

  assert.equal(enriched.title, "Launch Scope Review");
  assert.notEqual(enriched.description, footer);
  assert.equal(enriched.fieldSources.description, "rules");
});

test("rejects a generated body excerpt as an event title", async () => {
  const input = {
    subject: "Invitation 48291",
    body: "Please join us for the quarterly engineering planning workshop on September 10, 2026 at 14:00. The agenda covers staffing and release risks.",
    date: REFERENCE,
  };
  const detected = detectEvent(input);
  const enriched = await enrichEvent(input, detected, async () => ({
    title: `${input.body} This should never be used as a calendar title.`,
    description: "Engineering leaders will review staffing and release risks.",
  }));

  assert.notEqual(enriched.title, `${input.body} This should never be used as a calendar title.`);
  assert.ok(enriched.title.length <= 100);
  assert.equal(
    enriched.description,
    "Engineering leaders will review staffing and release risks.",
  );
});

test("detects Turkish event wording and a time range", () => {
  const event = detectEvent({
    subject: "Fon toplantısı",
    body: "Toplantı 12 Eylül 2026 saat 14.00-15.30 TRT\nYer: İstanbul Ofisi",
    date: REFERENCE,
  });

  assert.equal(event.detected, true);
  assert.equal(event.startDate, "2026-09-12");
  assert.equal(event.startTime, "14:00");
  assert.equal(event.endTime, "15:30");
  assert.equal(event.timezoneOffsetMinutes, 180);
  assert.equal(event.location, "İstanbul Ofisi");
});

test("extracts Turkish-labelled multi-part addresses", () => {
  const event = detectEvent({
    subject: "Yatırımcı toplantısı",
    body: "Toplantı 18 Eylül 2026 saat 10.00'da yapılacaktır. Konum: Yapı Kredi Plaza, D Blok, Kat 8, Levent / İstanbul\nEtkinlik 90 dakika sürecektir.",
    date: REFERENCE,
  });

  assert.equal(
    event.location,
    "Yapı Kredi Plaza, D Blok, Kat 8, Levent / İstanbul",
  );
  assert.equal(event.endTime, "11:30");
  assert.equal(event.durationSource, "explicit");
});

test("extracts a property viewing without including its schedule in the address", async () => {
  const input = {
    subject: "Viewing confirmation",
    body: [
      "Dear Mr Kaya",
      "This is confirmation of your viewing of:",
      "Flat 8, Brunswick Court, 1 Darlaston Road, Wimbledon, London, SW19 4LF on Sat 05/09 at 15:30",
      "If you have any questions please do call me and I look forward to seeing you.",
      "Kind regards",
      "Kirsty O'Shaughnessy",
    ].join("\n\n"),
    date: REFERENCE,
  };

  const event = await enrichEvent(input, detectEvent(input));

  assert.equal(event.detected, true);
  assert.equal(event.startDate, "2026-09-05");
  assert.equal(event.startTime, "15:30");
  assert.equal(
    event.location,
    "Flat 8, Brunswick Court, 1 Darlaston Road, Wimbledon, London, SW19 4LF",
  );
  assert.equal(event.title, "Property Viewing — Flat 8, Brunswick Court");
  assert.equal(
    event.description,
    "Property viewing at Flat 8, Brunswick Court, 1 Darlaston Road, Wimbledon, London, SW19 4LF.",
  );
});

test("resolves relative dates from the email date", () => {
  const event = detectEvent({
    subject: "Customer webinar",
    body: "The webinar is tomorrow at 11:00.",
    date: REFERENCE,
  });

  assert.equal(event.detected, true);
  assert.equal(event.startDate, "2026-09-04");
  assert.equal(event.startTime, "11:00");
});

test("resolves British numeric dates without a year", () => {
  const event = detectEvent({
    subject: "Viewing confirmation",
    body: "Property viewing at Flat 8, Brunswick Court on Sat 05/09 at 15:30.",
    date: new Date("2026-09-03T09:00:00Z"),
  });

  assert.equal(event.detected, true);
  assert.equal(event.startDate, "2026-09-05");
  assert.equal(event.startTime, "15:30");
});

test("does not treat an invoice date as an event", () => {
  const event = detectEvent({
    subject: "Your invoice",
    body: "Invoice date 12 September 2026. Amount due: 900 TRY.",
    date: REFERENCE,
  });

  assert.equal(event.detected, false);
});

test("creates timezone-correct data for Thunderbird Calendar", () => {
  const calendar = createIcs({
    title: "Review, planning",
    startDate: "2026-09-10",
    startTime: "14:30",
    endDate: "2026-09-10",
    endTime: "15:30",
    timezoneOffsetMinutes: 60,
    location: "Room 4",
    description: "Line one\nLine two",
    sourceMessageId: "message-42@example.com",
  }, new Date("2026-09-03T12:00:00Z"));

  assert.match(calendar, /DTSTART:20260910T133000Z\r\n/);
  assert.match(calendar, /DTEND:20260910T143000Z\r\n/);
  assert.match(calendar, /SUMMARY:Review\\, planning\r\n/);
  assert.match(calendar, /DESCRIPTION:Line one\\nLine two\r\n/);
  assert.match(calendar, /END:VCALENDAR\r\n$/);
});

test("creates an inclusive all-day event using an exclusive end date", () => {
  const calendar = createIcs({
    title: "Conference",
    startDate: "2026-09-10",
    allDay: true,
  });

  assert.match(calendar, /DTSTART;VALUE=DATE:20260910/);
  assert.match(calendar, /DTEND;VALUE=DATE:20260911/);
});
