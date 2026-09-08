const MONTHS = new Map([
  ["january", 1], ["jan", 1], ["ocak", 1],
  ["february", 2], ["feb", 2], ["subat", 2],
  ["march", 3], ["mar", 3], ["mart", 3],
  ["april", 4], ["apr", 4], ["nisan", 4],
  ["may", 5], ["mayis", 5],
  ["june", 6], ["jun", 6], ["haziran", 6],
  ["july", 7], ["jul", 7], ["temmuz", 7],
  ["august", 8], ["aug", 8], ["agustos", 8],
  ["september", 9], ["sep", 9], ["sept", 9], ["eylul", 9],
  ["october", 10], ["oct", 10], ["ekim", 10],
  ["november", 11], ["nov", 11], ["kasim", 11],
  ["december", 12], ["dec", 12], ["aralik", 12],
]);

const WEEKDAYS = new Map([
  ["sunday", 0], ["sun", 0], ["pazar", 0],
  ["monday", 1], ["mon", 1], ["pazartesi", 1],
  ["tuesday", 2], ["tue", 2], ["sali", 2],
  ["wednesday", 3], ["wed", 3], ["carsamba", 3],
  ["thursday", 4], ["thu", 4], ["persembe", 4],
  ["friday", 5], ["fri", 5], ["cuma", 5],
  ["saturday", 6], ["sat", 6], ["cumartesi", 6],
]);

const EVENT_PATTERN = /\b(?:meeting|meetup|appointment|viewing|inspection|webinar|conference|interview|call|workshop|seminar|standup|sync|demo|presentation|training|town hall|office hours|flight|reservation|booking|concert|dinner|lunch|breakfast|lesson|class|party|birthday|doctor|dentist|toplanti|bulusma|randevu|etkinlik|konferans|gorusme|calistay|seminer|sunum|egitim|ucus|rezervasyon|konser|yemek|ders|dogum gunu)\b/i;
const MONTH_PATTERN = [...MONTHS.keys()].sort((a, b) => b.length - a.length).join("|");
const WEEKDAY_PATTERN = [...WEEKDAYS.keys()].sort((a, b) => b.length - a.length).join("|");
const TIME_ZONE_OFFSETS = new Map([
  ["UTC", 0], ["GMT", 0], ["BST", 60], ["CET", 60],
  ["CEST", 120], ["EET", 120], ["EEST", 180], ["TRT", 180],
]);

function canonical(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[ç]/g, "c")
    .replace(/[ğ]/g, "g")
    .replace(/[ı]/g, "i")
    .replace(/[ö]/g, "o")
    .replace(/[ş]/g, "s")
    .replace(/[ü]/g, "u")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function dateString(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function normalizedReference(value) {
  const date = new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function inferredYear(month, day, suppliedYear, reference) {
  if (suppliedYear) {
    const numeric = Number(suppliedYear);
    return numeric < 100 ? 2000 + numeric : numeric;
  }
  let year = reference.getFullYear();
  const candidate = Date.UTC(year, month - 1, day);
  const referenceDay = Date.UTC(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate(),
  );
  if (candidate < referenceDay - 30 * 24 * 60 * 60 * 1000) year += 1;
  return year;
}

function makeDateMatch(month, day, year, reference, index, length) {
  const resolvedYear = inferredYear(month, day, year, reference);
  if (!validDate(resolvedYear, month, day)) return undefined;
  return {
    date: dateString(resolvedYear, month, day),
    index,
    length,
  };
}

function addDays(value, amount) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return dateString(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function findDate(text, referenceValue) {
  const source = canonical(text);
  const reference = normalizedReference(referenceValue);
  let match;

  match = /\b(20\d{2})[-/]([01]?\d)[-/]([0-3]?\d)\b/.exec(source);
  if (match) {
    const candidate = makeDateMatch(
      Number(match[2]), Number(match[3]), match[1], reference,
      match.index, match[0].length,
    );
    if (candidate) return candidate;
  }

  match = /\b([0-3]?\d)[./-]([01]?\d)[./-](20\d{2}|\d{2})\b/.exec(source);
  if (match) {
    const candidate = makeDateMatch(
      Number(match[2]), Number(match[1]), match[3], reference,
      match.index, match[0].length,
    );
    if (candidate) return candidate;
  }

  match = /\b([0-3]?\d)[./-]([01]?\d)(?![./-]\d)\b/.exec(source);
  if (match) {
    const candidate = makeDateMatch(
      Number(match[2]), Number(match[1]), undefined, reference,
      match.index, match[0].length,
    );
    if (candidate) return candidate;
  }

  match = new RegExp(
    `\\b([0-3]?\\d)(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})(?:\\s*,?\\s*(20\\d{2}|\\d{2}))?\\b`,
    "i",
  ).exec(source);
  if (match) {
    const candidate = makeDateMatch(
      MONTHS.get(match[2]), Number(match[1]), match[3], reference,
      match.index, match[0].length,
    );
    if (candidate) return candidate;
  }

  match = new RegExp(
    `\\b(${MONTH_PATTERN})\\s+([0-3]?\\d)(?:st|nd|rd|th)?(?:\\s*,?\\s*(20\\d{2}|\\d{2}))?\\b`,
    "i",
  ).exec(source);
  if (match) {
    const candidate = makeDateMatch(
      MONTHS.get(match[1]), Number(match[2]), match[3], reference,
      match.index, match[0].length,
    );
    if (candidate) return candidate;
  }

  match = /\b(day after tomorrow|obur gun|yarin|tomorrow|bugun|today)\b/i.exec(source);
  if (match) {
    const offset = /day after tomorrow|obur gun/i.test(match[1])
      ? 2
      : /yarin|tomorrow/i.test(match[1]) ? 1 : 0;
    const base = dateString(
      reference.getFullYear(),
      reference.getMonth() + 1,
      reference.getDate(),
    );
    return { date: addDays(base, offset), index: match.index, length: match[0].length };
  }

  match = new RegExp(
    `\\b(?:(next|this|gelecek|bu)\\s+)?(${WEEKDAY_PATTERN})\\b`,
    "i",
  ).exec(source);
  if (match) {
    const target = WEEKDAYS.get(match[2]);
    let offset = (target - reference.getDay() + 7) % 7;
    if (/next|gelecek/i.test(match[1] ?? "") && offset === 0) offset = 7;
    const base = dateString(
      reference.getFullYear(),
      reference.getMonth() + 1,
      reference.getDate(),
    );
    return { date: addDays(base, offset), index: match.index, length: match[0].length };
  }

  return undefined;
}

function clock(hourValue, minuteValue = "0", meridiemValue = "") {
  let hour = Number(hourValue);
  const minute = Number(minuteValue || 0);
  const meridiem = String(meridiemValue ?? "").toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (meridiem === "pm" && hour !== 12) hour += 12;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  return `${pad(hour)}:${pad(minute)}`;
}

function overlapsDate(match, dateMatch) {
  if (!dateMatch) return false;
  return match.index < dateMatch.index + dateMatch.length &&
    match.index + match[0].length > dateMatch.index;
}

function timezoneNear(text, index, length) {
  const nearby = text.slice(Math.max(0, index - 8), index + length + 16);
  const named = /\b(UTC|GMT|BST|CET|CEST|EET|EEST|TRT)\b/i.exec(nearby);
  if (named) {
    const label = named[1].toUpperCase();
    return { label, offsetMinutes: TIME_ZONE_OFFSETS.get(label) };
  }
  const numeric = /(?:UTC|GMT)?\s*([+-])(\d{2}):?(\d{2})\b/i.exec(nearby);
  if (numeric) {
    const sign = numeric[1] === "-" ? -1 : 1;
    const offsetMinutes = sign * (Number(numeric[2]) * 60 + Number(numeric[3]));
    return { label: numeric[0].trim(), offsetMinutes };
  }
  return {};
}

function findTime(text, dateMatch) {
  const source = canonical(text);
  const candidates = [];
  const push = (match, start, end) => {
    if (!start || overlapsDate(match, dateMatch)) return;
    const timezone = timezoneNear(text, match.index, match[0].length);
    candidates.push({
      start,
      end,
      index: match.index,
      distance: (dateMatch ? Math.abs(match.index - dateMatch.index) : match.index) -
        (end ? 20 : 0),
      ...timezone,
    });
  };

  const rangePattern = /\b(\d{1,2})(?::|\.)([0-5]\d)\s*(am|pm)?\s*(?:-|–|—|to|until|ile)\s*(\d{1,2})(?::|\.)([0-5]\d)\s*(am|pm)?\b/gi;
  for (const match of source.matchAll(rangePattern)) {
    const firstMeridiem = match[3] || match[6];
    const secondMeridiem = match[6] || match[3];
    push(
      match,
      clock(match[1], match[2], firstMeridiem),
      clock(match[4], match[5], secondMeridiem),
    );
  }

  const labelledRangePattern = /\b(?:start|starts|begins|baslangic)\s*(?:at|:)?\s*(\d{1,2})(?:(?::|\.)([0-5]\d))?\s*(am|pm)?[\s\S]{0,40}?\b(?:end|ends|finishes|bitis)\s*(?:at|:)?\s*(\d{1,2})(?:(?::|\.)([0-5]\d))?\s*(am|pm)?\b/gi;
  for (const match of source.matchAll(labelledRangePattern)) {
    const firstMeridiem = match[3] || match[6];
    const secondMeridiem = match[6] || match[3];
    push(
      match,
      clock(match[1], match[2], firstMeridiem),
      clock(match[4], match[5], secondMeridiem),
    );
  }

  const flexibleRangePattern = /\b(from|between|saat)?\s*(\d{1,2})(?:(?::|\.)([0-5]\d))?\s*(am|pm)?\s*(?:-|–|—|to|until|and|ile|ve)\s*(\d{1,2})(?:(?::|\.)([0-5]\d))?\s*(am|pm)?\b/gi;
  for (const match of source.matchAll(flexibleRangePattern)) {
    const hasUnambiguousTimeSignal = Boolean(
      match[1] || match[3] || match[4] || match[6] || match[7],
    );
    if (!hasUnambiguousTimeSignal) continue;
    const firstMeridiem = match[4] || match[7];
    const secondMeridiem = match[7] || match[4];
    push(
      match,
      clock(match[2], match[3], firstMeridiem),
      clock(match[5], match[6], secondMeridiem),
    );
  }

  const prefixedPattern = /\b(?:at|saat)\s+(\d{1,2})(?:(?::|\.)([0-5]\d))?\s*(am|pm)?\b/gi;
  for (const match of source.matchAll(prefixedPattern)) {
    push(match, clock(match[1], match[2], match[3]));
  }

  const clockPattern = /\b(\d{1,2})(?::|\.)([0-5]\d)\s*(am|pm)?\b/gi;
  for (const match of source.matchAll(clockPattern)) {
    push(match, clock(match[1], match[2], match[3]));
  }

  const meridiemPattern = /\b(\d{1,2})\s*(am|pm)\b/gi;
  for (const match of source.matchAll(meridiemPattern)) {
    push(match, clock(match[1], 0, match[2]));
  }

  candidates.sort((left, right) => left.distance - right.distance);
  return candidates[0];
}

function explicitDurationMinutes(text) {
  const source = canonical(text);
  if (/\b(?:half an hour|yarim saat)\b/.test(source)) return 30;

  const suffixed = /\b(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|minutes?|mins?|saat|dakika)\s*(?:long|surecek(?:tir)?|surer)\b/.exec(source);
  if (suffixed) {
    const amount = Number(suffixed[1].replace(",", "."));
    return /hour|hr|saat/.test(suffixed[2])
      ? Math.round(amount * 60)
      : Math.round(amount);
  }

  const compound = /\b(\d+)\s*(?:hours?|hrs?|saat)\s*(?:(\d+)\s*(?:minutes?|mins?|dakika))?\b/.exec(source);
  if (compound) return Number(compound[1]) * 60 + Number(compound[2] || 0);

  const labelled = /\b(?:duration|lasting|lasts?|for|sure|suresi)\s*(?:is|:)?\s*(\d+(?:[.,]\d+)?)\s*(hours?|hrs?|minutes?|mins?|saat|dakika)\b/.exec(source);
  if (!labelled) return undefined;
  const amount = Number(labelled[1].replace(",", "."));
  return /hour|hr|saat/.test(labelled[2])
    ? Math.round(amount * 60)
    : Math.round(amount);
}

function inferredDurationMinutes(text) {
  const source = canonical(text);
  if (/\b(?:standup|daily sync|check-in|check in|one-on-one|1:1)\b/.test(source)) return 30;
  if (/\b(?:doctor|dentist|appointment|randevu)\b/.test(source)) return 30;
  if (/\b(?:interview|gorusme)\b/.test(source)) return 60;
  if (/\b(?:workshop|calistay|training|egitim)\b/.test(source)) return 120;
  if (/\b(?:lunch|dinner|breakfast|yemek)\b/.test(source)) return 90;
  if (/\b(?:webinar|seminar|seminer|lesson|class|ders|presentation|sunum)\b/.test(source)) return 60;
  if (/\b(?:call|meeting|toplanti|sync|demo)\b/.test(source)) return 30;
  return 60;
}

function addMinutes(dateValue, timeValue, amount) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const [hour, minute] = timeValue.split(":").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute + amount));
  return {
    date: dateString(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()),
    time: `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`,
  };
}

const LOCATION_SECTION_HEADINGS = new Set([
  "where", "location", "venue", "address", "place",
  "yer", "konum", "adres", "mekan",
]);
const LOCATION_SECTION_ENDINGS = new Set([
  "when", "hosted by", "rough timings", "presentations by", "agenda",
  "precise entrance location", "want to give a talk", "sponsor or host us",
  "ne zaman", "program", "gundem", "ev sahibi",
]);
const UK_POSTCODE_PATTERN = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;
const STREET_ADDRESS_PATTERN = /\b\d{1,5}\s+[^\n,]{1,80}\b(?:st(?:reet)?|rd|road|ave(?:nue)?|boulevard|blvd|lane|ln|square|sq|way|court|ct|place|pl|caddesi|sokak)\b/iu;

function headingText(value) {
  return canonical(value)
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function physicalLocationScore(value) {
  let score = 0;
  if (UK_POSTCODE_PATTERN.test(value)) score += 20;
  if (STREET_ADDRESS_PATTERN.test(value)) score += 12;
  if (/\b(?:office|hotel|room|floor|building|centre|center|plaza|ofis|otel|salon|kat)\b/iu.test(value)) {
    score += 5;
  }
  if (/\bwhat3words\b|\bw3w\.co\b/i.test(value)) score -= 30;
  if (/^https?:\/\//i.test(value)) score -= 20;
  return score;
}

function locationFromSections(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim());
  const candidates = [];

  for (let index = 0; index < lines.length; index += 1) {
    const heading = headingText(lines[index]);
    if (!LOCATION_SECTION_HEADINGS.has(heading)) continue;
    const values = [];
    for (let cursor = index + 1; cursor < lines.length && values.length < 5; cursor += 1) {
      const line = lines[cursor];
      if (!line) continue;
      const possibleHeading = headingText(line);
      if (LOCATION_SECTION_ENDINGS.has(possibleHeading)) break;
      if (/^https?:\/\//i.test(line) || /\bwhat3words\b|\bw3w\.co\b/i.test(line)) {
        continue;
      }
      values.push(line.replace(/[.;]+$/, ""));
    }

    const address = values
      .filter((value) => physicalLocationScore(value) >= 12)
      .sort((left, right) =>
        physicalLocationScore(right) - physicalLocationScore(left) ||
        right.length - left.length)[0];
    if (!address) continue;
    candidates.push({
      location: address,
      score: physicalLocationScore(address) +
        (heading === "location" || heading === "konum" ? 3 : 0),
      index,
    });
  }

  candidates.sort((left, right) =>
    right.score - left.score || right.index - left.index);
  return candidates[0]?.location ?? "";
}

function locationFromText(text) {
  const sectionLocation = locationFromSections(text);
  const labelled = /\b(?:location|venue|where|address|room|place|yer|konum|adres|salon|oda|mek[aâ]n)\s*(?::|-|is|=)\s*([^\n\r]{2,240})/imu.exec(text);
  const meetingUrl = /https?:\/\/[^\s<>()]*(?:zoom\.us|teams\.microsoft|meet\.google|webex|whereby\.com)[^\s<>()]*/i.exec(text)?.[0]
    ?.replace(/[),.;]+$/, "");
  const mapUrl = /https?:\/\/[^\s<>()]*(?:maps\.google|google\.[^/]+\/maps|maps\.apple|goo\.gl\/maps)[^\s<>()]*/i.exec(text)?.[0]
    ?.replace(/[),.;]+$/, "");
  const inline = /\b(?:held|hosted|takes? place|meeting|appointment|meet)\s+(?:at|in)\s+([\p{L}\d][^\n.;]{2,120})/iu.exec(text)?.[1]
    ?.replace(/\s+(?:on|from|starting)\s+(?=\d|january|february|march|april|may|june|july|august|september|october|november|december).*/i, "")
    .trim();
  const turkishInline = /\b(?:toplant[ıi]|randevu|etkinlik|görüşme)\s+([^\n.;]{2,100}?(?:ofisinde|salonunda|merkezinde|otelinde|adresinde))\b/iu.exec(text)?.[1]
    ?.trim();
  const turkishAddress = /(?:saat\s+\d{1,2}(?:(?::|\.)\d{2})?(?:'?[dt][ae])?|günü)\s+([^\n.;]{3,180}?)\s+adresinde\b/iu.exec(text)?.[1]
    ?.trim();
  const addressLine = /(?:^|\n)\s*([^\n]{3,180}?(?:street|road|avenue|boulevard|lane|square|plaza|hotel|office|room|floor|caddesi|sokak|mahallesi|bulvar[ıi]|otel|ofis|salon|kat)\b[^\n]*)$/imu.exec(text)?.[1]
    ?.trim();
  const onlineProvider = /\b(?:via|on|over|through|üzerinden|uzerinden)\s+(Zoom|Microsoft Teams|Teams|Google Meet|Webex)\b/iu.exec(text)?.[1];
  const cleanLocation = (value) => value
    ?.replace(
      /\s+on\s+(?:(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\s+)?\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\s+(?:at\s+)?\d{1,2}(?::|\.)\d{2}.*$/i,
      "",
    )
    .replace(
      /\s+(?:on|at|from|starting)\s+(?=(?:mon|tue|wed|thu|fri|sat|sun|\d{1,2}[./-]))[\s\S]*$/i,
      "",
    )
    .replace(/[.;]+$/, "")
    .trim()
    .slice(0, 240);
  const labelledLocation = cleanLocation(labelled?.[1]
    ?.replace(/\s+(?:date|tarih|time|saat|starts?|başlangıç|baslangic)\s*:.*/iu, "")
  );
  return {
    location: sectionLocation || labelledLocation || cleanLocation(inline) || cleanLocation(turkishInline) || cleanLocation(turkishAddress) || cleanLocation(addressLine) || meetingUrl || mapUrl || onlineProvider || "",
    meetingUrl: meetingUrl || "",
  };
}

function cleanTitle(subject) {
  return String(subject ?? "Event")
    .replace(/^(?:(?:re|fw|fwd|ynt|ilet)\s*:\s*)+/i, "")
    .replace(/^(?:you(?:'re| are)\s+(?:attending|confirmed for)|attendance confirmed(?: for)?)\s*:\s*/i, "")
    .trim() || "Event";
}

function candidateSentences(input) {
  return String(input?.body ?? "")
    .split(/\n+|(?<=[.!?])\s+/u)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length >= 8 && sentence.length <= 280)
    .filter((sentence) => !/^(?:from|to|subject|sent|unsubscribe|view in browser)\s*:/i.test(sentence))
    .slice(0, 30);
}

function conciseTitleFromSentence(sentence) {
  let title = String(sentence ?? "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/^(?:please\s+)?(?:join (?:us for|our)|you are invited to|invitation to|we(?:'d| would) like to invite you to|save the date for)\s+/i, "")
    .replace(/^(?:sizi\s+)?(.+?)\s+(?:icin\s+)?davet ediyoruz\s*[:\-]?\s*/i, "$1 ")
    .replace(/^(?:this is\s+)?(?:a\s+)?reminder\s+(?:for|about|that)\s+/i, "")
    .replace(/\s+(?:will be held|takes? place|is scheduled|scheduled for|on|from|starting)\s+(?=\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december).*$/i, "")
    .replace(/\s+(?:tarihinde|saat)\s+.*$/i, "")
    .replace(/\s+\d{1,2}\s+(?:ocak|şubat|subat|mart|nisan|mayıs|mayis|haziran|temmuz|ağustos|agustos|eylül|eylul|ekim|kasım|kasim|aralık|aralik)\s+20\d{2}.*$/iu, "")
    .replace(/\s+(?:is|will be)$/i, "")
    .replace(/^the\s+/i, "")
    .replace(/[.!,:;\-\s]+$/g, "")
    .trim();
  if (title.length > 90) {
    title = `${title.slice(0, 87).replace(/\s+\S*$/, "")}…`;
  }
  return title;
}

function usefulTitle(title) {
  return title.length >= 4 &&
    !/^(?:event|meeting|toplanti|invitation|reminder|save the date|join us|you(?:'re| are) confirmed(?: for)?)$/i.test(canonical(title));
}

function compactDescription(sentences, titleSentence) {
  return sentences
    .filter((sentence) => sentence !== titleSentence)
    .slice(0, 2)
    .join(" ")
    .slice(0, 700)
    .trim();
}

const AGENDA_HEADINGS = new Set([
  "agenda", "rough timings", "schedule", "programme", "program",
  "gundem", "etkinlik programi",
]);
const AGENDA_ENDINGS = [
  "want to give a talk", "submit your talk", "presentations by",
  "sponsor or host us", "sponsors", "cant make it", "can t make it",
  "konusma yapmak ister", "sunumlar", "sponsor",
];
const AGENDA_TIME_PATTERN = /^\d{1,2}(?::|\.)\d{2}\s*(?:am|pm)?(?:\s*(?:-|–|—|to)\s*\d{1,2}(?:(?::|\.)\d{2})?\s*(?:am|pm)?)?\s*:/i;

function agendaDescription(input) {
  const lines = String(input?.body ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim());
  const headingIndex = lines.findIndex((line) =>
    AGENDA_HEADINGS.has(headingText(line)));
  if (headingIndex < 0) return "";

  const entries = [];
  let current = "";
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const normalized = headingText(line);
    if (
      entries.length + Number(Boolean(current)) > 0 &&
      AGENDA_ENDINGS.some((ending) => normalized.startsWith(ending))
    ) {
      break;
    }
    if (AGENDA_TIME_PATTERN.test(line)) {
      if (current) entries.push(current);
      current = line;
      continue;
    }
    if (!current) continue;
    if (!normalized || /^https?:\/\//i.test(line)) continue;
    current = `${current} ${line}`;
  }
  if (current) entries.push(current);
  if (entries.length < 2) return "";
  return `Agenda:\n${entries.join("\n")}`.slice(0, 1800).trim();
}

function validGeneratedTitle(value, input) {
  let title = String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/^(?:reminder|confirmation|invitation|hat[ıi]rlatma(?:s[ıi])?|davet)\s*[:—–-]\s*/iu, "")
    .replace(/\s+(?:reminder|confirmation|invitation|hat[ıi]rlatma(?:s[ıi])?|onay[ıi]|daveti)\s*$/iu, "")
    .replace(/\b\d{5,}\b/g, "")
    .replace(/[\s:—–-]+$/g, "")
    .trim();
  const words = title.split(/\s+/).filter(Boolean);
  if (title.length < 4 || title.length > 100 || words.length > 16) return "";
  if (/^(?:title|subject|body|description)\s*:/i.test(title)) return "";
  const subject = cleanTitle(input?.subject);
  const repeatsSubject = canonical(title.replace(/[*_]/g, "")) === canonical(subject);
  const subjectNamesAnEvent = EVENT_PATTERN.test(canonical(subject));
  if (repeatsSubject && !subjectNamesAnEvent) return "";
  const letters = title.replace(/[^\p{L}]/gu, "");
  if (letters.length >= 4 && letters === letters.toLocaleUpperCase()) {
    title = title
      .toLocaleLowerCase()
      .replace(/^\p{L}/u, (letter) => letter.toLocaleUpperCase());
  }
  return usefulTitle(title) ? title : "";
}

function containsUnexpectedScript(value, source) {
  for (const script of ["Han", "Cyrillic", "Arabic", "Hebrew"]) {
    const pattern = new RegExp(`\\p{Script=${script}}`, "u");
    if (pattern.test(value) && !pattern.test(source)) return true;
  }
  return false;
}

function validGeneratedDescription(value, input) {
  const description = String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/^(?:description|summary)\s*:\s*/i, "")
    .trim();
  if (description.length < 8) return "";
  if (description.length > 360 || description.split(/\s+/).length > 55) return "";
  if (/\b(?:3\s*(?:-|–)\s*8 words?|event summary|target email|calendar fields?)\b/i.test(description)) {
    return "";
  }
  if (/\b(?:unsubscribe|privacy policy|all rights reserved|view in browser|kind regards|best regards|sayg[ıi]lar|yasal uyar[ıi])\b/i.test(description)) {
    return "";
  }
  if (containsUnexpectedScript(description, `${input?.subject ?? ""}\n${input?.body ?? ""}`)) {
    return "";
  }
  return description;
}

function fallbackEventSentences(input) {
  return candidateSentences(input)
    .filter((sentence) =>
      !/\b(?:unsubscribe|privacy policy|all rights reserved|view in browser|manage preferences)\b/i.test(sentence),
    );
}

function fallbackEventTitle(input) {
  const sentences = fallbackEventSentences(input);
  const source = `${input?.subject ?? ""}\n${input?.body ?? ""}`;
  if (/\b(?:property\s+)?viewing\b/i.test(source)) {
    const shortLocation = locationFromText(source).location
      .split(",")
      .slice(0, 2)
      .join(",")
      .trim();
    return shortLocation
      ? `Property Viewing — ${shortLocation}`
      : "Property Viewing";
  }
  const subject = cleanTitle(input?.subject);
  const subjectIsVague = /^(?:reminder|invitation|update|notice|notification|save the date|hatirlatma|davet|duyuru)(?:\s|\W|\d)*$/i.test(canonical(subject));
  if (!subjectIsVague && EVENT_PATTERN.test(canonical(subject)) && usefulTitle(subject)) {
    return subject;
  }
  const candidate = sentences.find((sentence) =>
    EVENT_PATTERN.test(canonical(sentence)) ||
    /\b(?:agenda|purpose|join|attend|katilim|gundem|davet)\b/i.test(canonical(sentence)),
  );
  const concise = conciseTitleFromSentence(candidate ?? "");
  const body = canonical(input?.body);
  if (!subjectIsVague && !EVENT_PATTERN.test(canonical(subject))) {
    if (/\b(?:toplanti|gorusme)\w*/u.test(body)) return `${subject} Toplantısı`;
    if (/\bworkshop\b/.test(body)) return `${subject} Workshop`;
    if (/\b(?:webinar|seminar)\b/.test(body)) return `${subject} Webinar`;
  }
  return validGeneratedTitle(concise, input) || subject;
}

function fallbackEventDescription(input, title) {
  const source = `${input?.subject ?? ""}\n${input?.body ?? ""}`;
  if (/\b(?:property\s+)?viewing\b/i.test(source)) {
    const location = locationFromText(source).location;
    return location ? `Property viewing at ${location}.` : "Property viewing.";
  }
  const agenda = agendaDescription(input);
  if (agenda) return agenda;
  const sentences = fallbackEventSentences(input)
    .filter((sentence) => !String(sentence).includes(title))
    .filter((sentence) =>
      !/^(?:location|venue|where|address|yer|konum|adres|duration|süre|suresi)\s*(?::|-|is)/i.test(sentence),
    );
  const purpose = sentences.find((sentence) =>
    /\b(?:agenda|purpose|review|discuss|decide|cover|present|share|learn|gündem|gundem|amaç|amac|değerlendir|degerlendir|görüş|gorus|paylaş|paylas|sunul|anlat|konuş|konus)\w*/iu.test(sentence),
  );
  return purpose || compactDescription(sentences, "") || "";
}

export async function enrichEvent(input, event, generateDetails) {
  let generated = {};
  let generationError = "";
  if (generateDetails) {
    try {
      generated = await generateDetails(input, event);
    } catch (error) {
      console.warn("Local event generation fell back to extraction rules", error);
      generationError = String(error?.message ?? error);
    }
  }

  const startDate = event?.startDate;
  const startTime = event?.startTime;
  let endDate = event?.endDate;
  let endTime = event?.endTime;
  const durationMinutes = event?.durationMinutes;
  const durationSource = event?.durationSource;
  if (startDate && startTime && (!endDate || !endTime)) {
    const calculated = addMinutes(
      startDate,
      startTime,
      durationMinutes ?? inferredDurationMinutes(`${input?.subject ?? ""}\n${input?.body ?? ""}`),
    );
    endDate = calculated.date;
    endTime = calculated.time;
  }

  const generatedTitle = validGeneratedTitle(generated.title, input);
  const title = generatedTitle || fallbackEventTitle(input);
  let generatedDescription = validGeneratedDescription(generated.description, input);
  const ruleLocation = event?.location || "";
  if (
    generatedDescription &&
    [ruleLocation]
      .filter(Boolean)
      .some((location) => canonical(location) === canonical(generatedDescription))
  ) {
    generatedDescription = "";
  }
  const extractedAgenda = agendaDescription(input);
  const description = extractedAgenda || generatedDescription || fallbackEventDescription(input, title);
  return {
    ...event,
    detected: Boolean(startDate),
    title,
    startDate,
    startTime,
    endDate: endDate || startDate,
    endTime,
    durationMinutes,
    durationSource,
    allDay: Boolean(startDate && !startTime),
    location: ruleLocation,
    meetingUrl: event?.meetingUrl || "",
    description,
    enrichmentEngine: generated._engine || "rules",
    enrichmentError: generationError,
    fieldSources: {
      title: generatedTitle ? "model" : "rules",
      description: generatedDescription && !extractedAgenda ? "model" : "rules",
      location: ruleLocation ? "rules" : "missing",
      start: event?.startDate ? "rules" : "missing",
      end: event?.durationSource === "range" || event?.durationSource === "explicit"
        ? "rules"
        : "inferred",
    },
    modelOutput: generated._raw || "",
  };
}

export function detectEvent(input, referenceValue = input?.date) {
  const text = `${input?.subject ?? ""}\n${input?.body ?? ""}`;
  const normalized = canonical(text);
  const dateMatch = findDate(text, referenceValue);
  const timeMatch = findTime(text, dateMatch);
  const location = locationFromText(text);
  const keywordFound = EVENT_PATTERN.test(normalized);
  const confidence = Math.min(
    1,
    (dateMatch ? 0.45 : 0) +
      (timeMatch ? 0.25 : 0) +
      (keywordFound ? 0.25 : 0) +
      (location.location ? 0.1 : 0),
  );
  const detected = Boolean(dateMatch && confidence >= 0.65);
  const explicitDuration = explicitDurationMinutes(text);
  const inferredDuration = explicitDuration ?? inferredDurationMinutes(text);
  const defaultEnd = dateMatch && timeMatch?.start
    ? addMinutes(dateMatch.date, timeMatch.start, inferredDuration)
    : undefined;

  return {
    detected,
    confidence,
    title: cleanTitle(input?.subject),
    startDate: dateMatch?.date ?? "",
    startTime: timeMatch?.start ?? "",
    endDate: timeMatch?.end
      ? dateMatch?.date ?? ""
      : defaultEnd?.date ?? dateMatch?.date ?? "",
    endTime: timeMatch?.end ?? defaultEnd?.time ?? "",
    durationMinutes: timeMatch?.end
      ? undefined
      : timeMatch?.start ? inferredDuration : undefined,
    durationSource: timeMatch?.end
      ? "range"
      : explicitDuration ? "explicit" : timeMatch?.start ? "inferred" : "",
    allDay: Boolean(dateMatch && !timeMatch?.start),
    location: location.location,
    meetingUrl: location.meetingUrl,
    timezoneLabel: timeMatch?.label ?? "",
    timezoneOffsetMinutes: Number.isFinite(timeMatch?.offsetMinutes)
      ? timeMatch.offsetMinutes
      : null,
    description: [
      input?.author ? `From: ${input.author}` : "",
      String(input?.body ?? "").slice(0, 1200),
    ].filter(Boolean).join("\n\n"),
    sourceMessageId: input?.headerMessageId ?? "",
  };
}

function compactDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Choose a valid event date.");
  }
  return value.replaceAll("-", "");
}

function utcDateTime(dateValue, timeValue, offsetMinutes) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const [hour, minute] = timeValue.split(":").map(Number);
  const timestamp = Date.UTC(year, month - 1, day, hour, minute) -
    offsetMinutes * 60 * 1000;
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}00Z`;
}

function localDateTime(dateValue, timeValue) {
  if (!/^\d{2}:\d{2}$/.test(timeValue)) {
    throw new Error("Choose a valid event time.");
  }
  return `${compactDate(dateValue)}T${timeValue.replace(":", "")}00`;
}

function escapeIcsText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function foldLine(line) {
  const encoder = new TextEncoder();
  const folded = [];
  let current = "";
  for (const character of line) {
    const limit = folded.length ? 74 : 75;
    if (current && encoder.encode(current + character).length > limit) {
      folded.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  folded.push(current);
  return folded.map((part, index) => index ? ` ${part}` : part).join("\r\n");
}

function stamp(value) {
  const date = normalizedReference(value);
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

export function createIcs(event, now = new Date()) {
  const title = String(event?.title ?? "").trim();
  if (!title) throw new Error("Enter an event title.");
  const startDate = String(event?.startDate ?? "");
  const allDay = Boolean(event?.allDay);
  const uid = event?.sourceMessageId
    ? `local-triage-${now.getTime()}.${String(event.sourceMessageId).replace(/[\r\n]/g, "")}`
    : `local-triage-${now.getTime()}@byk.im`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Local Triage//Email Event//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(uid)}`,
    `DTSTAMP:${stamp(now)}`,
  ];

  if (allDay) {
    lines.push(`DTSTART;VALUE=DATE:${compactDate(startDate)}`);
    lines.push(`DTEND;VALUE=DATE:${compactDate(addDays(startDate, 1))}`);
  } else {
    const startTime = String(event?.startTime ?? "");
    const endTime = String(event?.endTime ?? "") || addMinutes(startDate, startTime, 60).time;
    let endDate = String(event?.endDate ?? "") || startDate;
    if (endDate === startDate && endTime <= startTime) endDate = addDays(startDate, 1);
    const offset = event?.timezoneOffsetMinutes;
    if (Number.isFinite(offset)) {
      lines.push(`DTSTART:${utcDateTime(startDate, startTime, offset)}`);
      lines.push(`DTEND:${utcDateTime(endDate, endTime, offset)}`);
    } else {
      lines.push(`DTSTART:${localDateTime(startDate, startTime)}`);
      lines.push(`DTEND:${localDateTime(endDate, endTime)}`);
    }
  }

  lines.push(`SUMMARY:${escapeIcsText(title)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  if (event.meetingUrl) lines.push(`URL:${String(event.meetingUrl).replace(/[\r\n]/g, "")}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  lines.push("STATUS:CONFIRMED", "END:VEVENT", "END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
