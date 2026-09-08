const status = document.querySelector("#status");
const classifyButton = document.querySelector("#classify-selected");
const smartOrderButton = document.querySelector("#enable-smart-order");
const settingsButton = document.querySelector("#open-settings");
const createEventButton = document.querySelector("#create-event");
const eventStatus = document.querySelector("#event-status");
const eventEditor = document.querySelector("#event-editor");
const eventTitle = document.querySelector("#event-title");
const eventStartDate = document.querySelector("#event-start-date");
const eventStartTime = document.querySelector("#event-start-time");
const eventEndDate = document.querySelector("#event-end-date");
const eventEndTime = document.querySelector("#event-end-time");
const eventAllDay = document.querySelector("#event-all-day");
const eventLocation = document.querySelector("#event-location");
const eventCalendar = document.querySelector("#event-calendar");
const eventDescription = document.querySelector("#event-description");
const eventTimezone = document.querySelector("#event-timezone");
const eventDiagnostics = document.querySelector("#event-diagnostics-content");
const saveEventButton = document.querySelector("#save-event");
const cancelEventButton = document.querySelector("#cancel-event");
let sortingActionActive = false;
let temporaryStatus;
let eventDraft;
let eventRequest;
let eventProbeRequest;
let eventReviewActive = false;
let eventCalendarWarning;
let eventTarget;

async function currentTabId() {
  const [tab] = await messenger.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tab?.id;
}

async function eventRequestPayload(type) {
  const tabId = eventTarget?.tabId ?? await currentTabId();
  return {
    type,
    tabId,
    ...(Number.isInteger(eventTarget?.messageId)
      ? { messageId: eventTarget.messageId }
      : {}),
  };
}

function missingReceiver(error) {
  return /Could not establish connection|Receiving end does not exist/i.test(
    String(error?.message ?? error),
  );
}

async function sendBackgroundMessage(request, retry = true) {
  try {
    return await messenger.runtime.sendMessage(request);
  } catch (error) {
    if (!retry || !missingReceiver(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 200));
    return messenger.runtime.sendMessage(request);
  }
}

function escapeText(value) {
  return String(value ?? "");
}

function showTemporaryStatus(text, durationMilliseconds = 5000) {
  temporaryStatus = {
    text,
    expiresAt: Date.now() + durationMilliseconds,
  };
  status.textContent = text;
}

function showEventStatus(text, isError = false) {
  eventStatus.hidden = !text;
  eventStatus.textContent = text;
  eventStatus.classList.toggle("error", isError);
}

function conciseEventDate(event) {
  if (!event?.startDate) return "";
  const date = new Date(`${event.startDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return event.startDate;
  const dateText = new Intl.DateTimeFormat(navigator.language, {
    month: "short",
    day: "numeric",
  }).format(date);
  return event.allDay || !event.startTime
    ? dateText
    : `${dateText}, ${event.startTime}`;
}

function updateAllDayInputs() {
  const allDay = eventAllDay.checked;
  for (const input of [eventStartTime, eventEndTime]) {
    input.disabled = allDay;
    input.required = !allDay;
  }
}

function populateEventEditor(event) {
  eventTitle.value = event.title ?? "";
  eventStartDate.value = event.startDate ?? "";
  eventStartTime.value = event.startTime ?? "";
  eventEndDate.value = event.endDate || event.startDate || "";
  eventEndTime.value = event.endTime ?? "";
  eventAllDay.checked = Boolean(event.allDay);
  eventLocation.value = event.location ?? "";
  eventDescription.value = event.description ?? "";
  const timingNote = event.durationSource === "inferred"
    ? `End time inferred from context (${event.durationMinutes} minutes).`
    : event.durationSource === "explicit"
      ? `Duration extracted from the message (${event.durationMinutes} minutes).`
      : "";
  const timezoneNote = event.timezoneLabel
    ? `Detected timezone: ${event.timezoneLabel}.`
    : "Times use your calendar's local timezone.";
  const sourceNote = event.enrichmentError
    ? `Generator failed; rules used: ${event.enrichmentError}`
    : `Extraction: ${event.enrichmentEngine ?? "rules"}.`;
  eventTimezone.textContent = `${sourceNote} ${timingNote} ${timezoneNote}`.trim();
  eventDiagnostics.textContent = JSON.stringify({
    engine: event.enrichmentEngine ?? "rules",
    cache: event.enrichmentCache ?? "none",
    error: event.enrichmentError || undefined,
    fieldSources: event.fieldSources,
    modelOutput: event.modelOutput || undefined,
    final: {
      title: event.title,
      startDate: event.startDate,
      startTime: event.startTime,
      endDate: event.endDate,
      endTime: event.endTime,
      location: event.location,
      description: event.description,
    },
  }, null, 2);
  updateAllDayInputs();
}

async function loadEventDraft(reportFailure = false) {
  if (eventDraft) return eventDraft;
  if (!eventRequest) {
    eventRequest = eventRequestPayload("prepare-event-review-selected")
      .then(sendBackgroundMessage)
      .finally(() => {
        eventRequest = undefined;
      });
  }
  try {
    const response = await eventRequest;
    if (!response?.ok) {
      if (reportFailure) showEventStatus(response?.error ?? "Could not inspect this message.", true);
      return undefined;
    }
    eventDraft = response.event;
    eventCalendarWarning = response.calendarWarning;
    populateCalendars(response.calendars, response.defaultCalendarId);
    const dateText = conciseEventDate(eventDraft);
    createEventButton.textContent = eventDraft.detected && dateText
      ? `Review detected event · ${dateText}`
      : "Create calendar event";
    if (eventDraft.detected) {
      showEventStatus(
        eventDraft.enrichmentError
          ? "Event detected, but the generator failed. Review the rule-based fields."
          : "Event details generated locally. Review before saving.",
        Boolean(eventDraft.enrichmentError),
      );
    }
    return eventDraft;
  } catch (error) {
    if (reportFailure) showEventStatus(`Failed: ${escapeText(error.message ?? error)}`, true);
    return undefined;
  }
}

function populateCalendars(calendars = [], defaultCalendarId = "") {
  eventCalendar.replaceChildren();
  for (const calendar of calendars) {
    const option = document.createElement("option");
    option.value = calendar.id;
    option.textContent = calendar.name;
    eventCalendar.append(option);
  }
  if (!calendars.length) {
    throw new Error("No writable Thunderbird calendar is available.");
  }
  if (calendars.some(({ id }) => id === defaultCalendarId)) {
    eventCalendar.value = defaultCalendarId;
  }
}

async function probeSelectedEvent() {
  createEventButton.hidden = true;
  if (!eventProbeRequest) {
    eventProbeRequest = eventRequestPayload("probe-event-selected")
      .then(sendBackgroundMessage)
      .finally(() => {
        eventProbeRequest = undefined;
      });
  }
  try {
    const response = await eventProbeRequest;
    if (!response?.ok || !response.detected) return;
    const dateText = conciseEventDate(response.event);
    createEventButton.textContent = dateText
      ? `Review detected event · ${dateText}`
      : "Review detected event";
    createEventButton.hidden = false;
  } catch {
    // The conditional action remains hidden when this message cannot be read.
  }
}

function showStatus(data) {
  if (sortingActionActive) return;
  if (temporaryStatus?.expiresAt > Date.now()) {
    status.textContent = temporaryStatus.text;
    return;
  }
  temporaryStatus = undefined;
  const run = data?.runStatus;
  const model = data?.modelStatus;
  if (run?.state === "running") {
    const backgroundPrefix = run.source === "selected" ? "" : "Background triage — ";
    const modelIsLoading = model?.state === "loading";
    if (run.stage === "classifying" && modelIsLoading) {
      const modelProgress = model.percent != null ? `: ${model.percent}%` : "…";
      status.textContent = `${backgroundPrefix}preparing local model${modelProgress} Message ${run.current ?? 1}/${run.total}.`;
      return;
    }
    const stages = {
      reading: "Reading",
      classifying: "Classifying",
      applying: "Applying tags to",
    };
    status.textContent = `${backgroundPrefix}${stages[run.stage] ?? "Classifying"} message ${run.current ?? run.completed + 1}/${run.total}…`;
    return;
  }
  if (run?.state?.startsWith("completed")) {
    const errors = Array.isArray(run.errors) ? run.errors.length : Number(run.errors ?? 0);
    const fallback = model?.state === "error" ? "; model fallback active" : "";
    status.textContent = `Classified ${run.completed}/${run.total}${errors ? `; ${errors} failed` : ""}${fallback}.`;
    return;
  }
  if (model?.state === "error") {
    status.textContent = "Model unavailable; heuristic fallback is active.";
    return;
  }
  if (model?.state && model.state !== "ready") {
    status.textContent = `Preparing local model${model.percent != null ? `: ${model.percent}%` : "…"}`;
    return;
  }
  status.textContent = "Ready. Select one or more messages.";
}

async function refreshStatus() {
  showStatus(await messenger.storage.local.get(["runStatus", "modelStatus"]));
}

classifyButton.addEventListener("click", async () => {
  classifyButton.disabled = true;
  status.textContent = "Classifying selected messages…";
  try {
    const response = await sendBackgroundMessage({
      type: "classify-selected",
    });
    if (response?.errors?.length) {
      showTemporaryStatus(`Failed: ${escapeText(response.errors[0].error)}`);
    } else if (!response?.results?.length) {
      showTemporaryStatus("No messages selected.");
    } else {
      const last = response.results.at(-1);
      showTemporaryStatus(
        `${response.results.length} classified. Last: ${escapeText(last.category)} / ${escapeText(last.priority)}.`,
      );
    }
  } catch (error) {
    showTemporaryStatus(`Failed: ${escapeText(error.message ?? error)}`);
  } finally {
    classifyButton.disabled = false;
  }
});

async function openEventReview() {
  createEventButton.disabled = true;
  eventReviewActive = true;
  showEventStatus("Extracting event details locally…");
  try {
    const event = await loadEventDraft(true);
    if (!event) return;
    populateEventEditor(event);
    eventEditor.hidden = false;
    showEventStatus(
      eventCalendarWarning
        ? `Event details are ready. Calendar selection warning: ${eventCalendarWarning}`
        : event.detected
        ? event.enrichmentError
          ? "Generator failed; review the rule-based fields and diagnostics."
          : "Event details generated locally. Review before saving."
        : "No confident event was detected; you can fill in the details manually.",
      Boolean(event.enrichmentError),
    );
    eventTitle.focus();
  } catch (error) {
    showEventStatus(`Failed: ${escapeText(error.message ?? error)}`, true);
  } finally {
    eventReviewActive = false;
    createEventButton.disabled = false;
  }
}

createEventButton.addEventListener("click", openEventReview);

eventAllDay.addEventListener("change", updateAllDayInputs);

cancelEventButton.addEventListener("click", () => {
  eventEditor.hidden = true;
  showEventStatus(eventDraft?.detected ? "Detected event is ready to review." : "");
});

eventEditor.addEventListener("submit", async (event) => {
  event.preventDefault();
  saveEventButton.disabled = true;
  showEventStatus("Adding event to Thunderbird Calendar…");
  const updatedEvent = {
    ...eventDraft,
    title: eventTitle.value.trim(),
    startDate: eventStartDate.value,
    startTime: eventAllDay.checked ? "" : eventStartTime.value,
    endDate: eventEndDate.value || eventStartDate.value,
    endTime: eventAllDay.checked ? "" : eventEndTime.value,
    allDay: eventAllDay.checked,
    location: eventLocation.value.trim(),
    description: eventDescription.value.trim(),
  };
  if (updatedEvent.location.startsWith("http")) {
    updatedEvent.meetingUrl = updatedEvent.location;
  }
  try {
    const response = await sendBackgroundMessage({
      type: "create-calendar-event",
      event: updatedEvent,
      calendarId: eventCalendar.value,
    });
    if (!response?.ok) throw new Error(response?.error ?? "Calendar event creation failed.");
    eventDraft = updatedEvent;
    eventEditor.hidden = true;
    showEventStatus(
      `Created “${escapeText(updatedEvent.title)}” in ${escapeText(response.created.calendar.name)}.`,
    );
  } catch (error) {
    showEventStatus(`Failed: ${escapeText(error.message ?? error)}`, true);
  } finally {
    saveEventButton.disabled = false;
  }
});

smartOrderButton.addEventListener("click", async () => {
  smartOrderButton.disabled = true;
  sortingActionActive = true;
  status.textContent = "Enabling priority + date order…";
  try {
    const response = await sendBackgroundMessage({
      type: "enable-smart-order",
    });
    showTemporaryStatus(
      response?.ok
        ? "Priority + date order enabled for this mail tab."
        : "Open a mail tab, then try again.",
    );
  } catch (error) {
    showTemporaryStatus(`Failed: ${escapeText(error.message ?? error)}`);
  } finally {
    sortingActionActive = false;
    smartOrderButton.disabled = false;
  }
});

settingsButton.addEventListener("click", () => messenger.runtime.openOptionsPage());

refreshStatus().catch((error) => {
  status.textContent = String(error.message ?? error);
});

async function initializeEventAction() {
  try {
    const response = await sendBackgroundMessage({
      type: "claim-event-review-target",
    });
    if (response?.target) eventTarget = response.target;
  } catch {
    // A native message-action popup can still resolve its active tab directly.
  }
  const actionRequestedReview =
    new URL(window.location.href).searchParams.get("eventReview") === "1";
  if (eventTarget || actionRequestedReview) {
    createEventButton.hidden = false;
    await openEventReview();
    return;
  }
  await probeSelectedEvent();
}

initializeEventAction().catch(console.error);

setInterval(refreshStatus, 1000);

messenger.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === "local" &&
    (changes.runStatus || changes.modelStatus)
  ) {
    refreshStatus().catch(console.error);
  }
  if (
    areaName === "local" &&
    changes.eventModelStatus &&
    eventReviewActive
  ) {
    const model = changes.eventModelStatus.newValue;
    if (["loading", "ready"].includes(model?.state) && model?.detail) {
      showEventStatus(model.detail);
    }
  }
});
