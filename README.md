# Local Triage for Thunderbird

Local Triage is a local-first Thunderbird extension that automatically categorizes incoming email, estimates its importance, and detects possible calendar events. It uses a quantized multilingual E5 encoder for triage. On Windows, deterministic calendar extraction is paired with Qwen3.5 0.8B on native CPU in a separate companion for concise titles and descriptions. Message text and model output stay on the computer.

This checkpoint provides categorization, priority buckets, automatic and manual processing, English/Turkish event extraction, a prefilled native Thunderbird event editor, a visible heuristic fallback, and native threaded Smart order for Thunderbird 153 and newer.

## Current behaviour

- Triages up to 50 unclassified messages in the current mail view once after installation or upgrade, yielding between messages so manual requests run promptly.
- Watches `messages.onNewMailReceived` afterwards.
- Extracts the readable text and relevant message headers.
- Downloads `Xenova/multilingual-e5-small` once, then runs it through the native CPU companion so inference cannot block Thunderbird's background process.
- Creates compact category labels such as `✦ Finance` and clean priority labels such as `P2 Normal`, while keeping collision-resistant internal keys.
- Preserves existing user tags and stars.
- Stores a numeric base score locally for the future threaded-sort provider.
- Adds a hidden `Smart priority + date` custom column activated from the toolbar popup.
- Uses P0–P3 as guardrails, then continuously ranks each bucket using the model score with a 72-hour age decay.
- Watches new-mail events and performs a one-minute safety scan for recent unclassified inbox mail.
- Shows native model initialization progress during classification, checks background health before each Settings test, and falls back to a deterministic classifier after a bounded timeout.
- Detects common English and Turkish event wording, dates, flexible time ranges, explicit durations, timezones, meeting links, and physical locations without sending the message anywhere.
- Uses multilingual Qwen3.5 0.8B through the native Windows CPU companion. Deterministic parsing owns date, time, duration, and location; Qwen writes only a short English or Turkish event title and one-sentence purpose summary. Validation rejects body-length titles, signatures, prompt leakage, foreign-script corruption, and vague-subject copies.
- Cross-checks generated dates, start/end times, duration, timezones, and locations against deterministic extraction. Explicit source values win; the model can fill gaps and infer duration but cannot replace a detected venue with an invented one.
- Infers a context-sensitive duration when no end time is present: short meetings and appointments default to 30 minutes, interviews/webinars to 60, meals to 90, and workshops to 120.
- Re-checks messages as they are displayed, applies a `✦ Event` tag, and shows the calendar action and context-menu command only for positively detected events.
- A calendar-icon or context-menu click opens Thunderbird's native event editor with the extracted fields and preferred writable calendar preselected. The event is saved only after review.
- Adds a theme-aware outline action to Thunderbird Conversations 4.3.x's conversation-level toolbar beside Archive. The bridge follows Conversations' nested shadow DOM and uses per-tab detection state instead of waiting for message-tag UI refreshes.
- Keeps native inference outside Thunderbird in a persistent, least-privilege native-messaging process. It packages the CPU ONNX Runtime, shares one model-load promise, serializes inference, and validates English and Turkish generation before reporting ready.
- Event creation starts Qwen on demand; it is not pre-warmed during Thunderbird startup, so it cannot delay automatic triage. Deterministic extraction still supplies and validates dates, times, duration, and locations if generation fails.
- Settings includes a dedicated **Download and test event model** action for the native Qwen3.5 CPU host. Diagnostics never include email content.
- Model download progress is monotonic and retains its determinate percentage while the native runtime reports concurrent files or initialization heartbeats.
- The popup reports whether the generator actually ran, identifies the source used for each field, and exposes the raw model output under **Extraction diagnostics**.

Message contents are never uploaded. The only network activity is the initial model downloads from Hugging Face.

The manifest declares no data collection. Model files are inert weights and tokenizer data; executable inference code is packaged in the native companion.

## Install the proof of concept

1. Close Thunderbird completely. On Windows x64, double-click `local-triage-windows-installer-0.13.9-win-x64.exe`. The installer refuses to update while Thunderbird is running, including in the background, so its XPI and native companion cannot become version-skewed. Native-companion upgrades must use this combined installer; installing only the XPI cannot replace the external host. The installer registers and launches a version check against the copied host, stops both versioned and older unversioned Local Triage host processes, and copies the matching XPI into the default Thunderbird profile's `extensions` directory. It does not launch Thunderbird with the XPI, and requires neither administrator access nor a PowerShell execution-policy change.
2. Start Thunderbird. If no default profile could be found, the installer instead selects the embedded `local-triage-0.13.9.xpi` in Explorer; install that file from Thunderbird's Add-ons Manager.
3. Extension-only fixes such as 0.13.13 can be installed from Thunderbird's Add-ons Manager without reinstalling the compatible 0.13.9 / runtime 30 native companion.
3. Run both model self-tests in Local Triage settings. The first test downloads and validates the approximately 120 MB bilingual encoder in the native companion; **Download and test event model** prepares and validates the approximately 668 MB Qwen3.5 Q4 model there as well. Both models are cached after their first download.
4. Open the toolbar popup and choose **Sort by priority, then date**. This enables threading and the custom order; do not select a separate Thunderbird sort mode.
5. Open a detected event message and click the calendar icon in the classic message header or Conversations' top quick-action bar, or right-click a detected message and choose **Create calendar event**. The action stays hidden for other messages. Review the prefilled native event editor, then save.
6. To review or change the extracted fields first, use **Review detected event** in the main Local Triage popup. It appears only when the selected message passes the fast local event check.

For development, run `npm install`, `npm test`, and `npm run package`, then load `dist/manifest.json` through Thunderbird's **Debug Add-ons** page.

For permanent installation, the XPI must be signed through Thunderbird Add-ons unless signature enforcement is disabled in a development profile.

## Development

```bash
npm test       # deterministic unit tests
npm run build  # build unpacked extension in dist/
npm run package
npm run build:native # package the XPI and combined Windows installer
```

The extension targets Manifest V3, requires Thunderbird 153 or newer, and does not declare a maximum version. Smart order, the final Calendar write, and Thunderbird Conversations UI compatibility use narrow, version-sensitive Experiment APIs because stable MailExtension APIs do not expose those operations across the Conversations reader. Their failures are isolated from classification and extraction. The native inference runtime is bundled in the Windows installer; model weights are fetched once because including every model asset would make rapid iteration cumbersome.

## Smart threaded sorting

Thunderbird's stable MailExtension API can select `sortType: "custom"` with `groupType: "groupedByThread"`, but cannot yet register the custom sortable value. This build includes a version-pinned Experiment API that:

1. Stores each base score as a custom message database property.
2. Registers a hidden `Smart priority + date` custom sort provider without displaying numeric values.
3. Keeps P0–P3 ordered while continuously combining the model score and message age within each bucket; threads inherit their strongest adjusted message.
4. Re-sorts whenever classification changes.

The pure ranking functions already live in `src/scoring.js`.

## Privacy and permissions

- `messagesRead`: read message metadata and body text.
- `messagesUpdate`: apply tags and optionally star P0 messages.
- `messagesTags` / `messagesTagsList`: create and inspect Local Triage tags.
- `accountsRead`: determine whether the user is a direct recipient.
- `storage`: store settings, rankings, and model/run status.
- `menus`: add **Create calendar event** to message context menus.
- `notifications`: report event-editor launch or extraction failures.
- `nativeMessaging`: connect only to `im.byk.local_triage`; the companion performs the initial Hugging Face model downloads and all learned inference outside Thunderbird.

## Known limitations

- The triage encoder and calendar generator both support English and Turkish. The generator is intentionally separate so event prose is generated rather than sliced from the email body.
- The Fossilize-packed combined installer currently targets Windows x64. It embeds both the XPI and native companion. It is not code-signed, so Windows may show a publisher warning during this development checkpoint. Windows still requires native DLLs to exist on disk while loaded, so the executable extracts its embedded CPU ONNX Runtime and `.node` binding into a versioned `%LOCALAPPDATA%\LocalTriage\native-runtime` cache on first model use.
- The XPI and native companion have separate lifecycles. Use the combined Windows installer for every release that changes inference; a plain XPI update cannot write or register an executable. The extension rejects a mismatched companion, retains deterministic event extraction, and falls back to heuristic classification.
- Event detection is deliberately conservative and handles common explicit or relative date expressions in English and Turkish. Direct creation is one click; the main popup remains available for reviewing ambiguous fields.
- Importance is initially zero-shot and becomes truly personal only after a feedback-learning layer is added.
- Encrypted message processing depends on Thunderbird being able to decrypt the message.
- Smart order and opening the native Calendar editor rely on Thunderbird internals and may need maintenance after a future API change; failures are isolated so categorization and tagging continue.
- The Conversations header integration currently targets Thunderbird Conversations 4.3.x's `conversation-header` and `conv-actions-buttons` open shadow roots. Its built-in protocol still has no clickable action registration, so an upstream action API would remove this DOM dependency.
- Automatic tag creation uses Thunderbird's current `messages.tags` API and should be verified against the exact target ESR before publishing.
- The release process exercises both multilingual E5 embeddings and English/Turkish Qwen generation through the real native-messaging protocol before packaging; Thunderbird UI integration still needs its Settings self-tests after installation.
