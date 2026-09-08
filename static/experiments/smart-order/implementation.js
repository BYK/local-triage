"use strict";

const COLUMN_ID = "localTriageSmartOrder";
const SCORE_PROPERTY = "localTriageBaseScore";
const PRIORITY_STEP = 1_000_000_000;
const SCORE_SCALE = 1_000_000;
const HALF_LIFE_HOURS = 72;

let ThreadPaneColumns;
let columnApiFailure;

for (const modulePath of [
  "chrome://messenger/content/thread-pane-columns.mjs",
  "chrome://messenger/content/ThreadPaneColumns.mjs",
]) {
  try {
    ({ ThreadPaneColumns } = ChromeUtils.importESModule(modulePath));
    if (ThreadPaneColumns) break;
  } catch (error) {
    columnApiFailure = error;
  }
}

if (!ThreadPaneColumns) {
  console.warn(
    "Local Triage Smart order is unavailable; classification will continue",
    columnApiFailure,
  );
}

function disableSmartOrder(message, error) {
  columnApiFailure = error;
  ThreadPaneColumns = undefined;
  console.warn(message, error);
}

function priorityRank(message) {
  const baseScore = Number.parseFloat(message.getStringProperty(SCORE_PROPERTY));
  if (!Number.isFinite(baseScore)) return 0;
  if (baseScore >= 80) return 3;
  if (baseScore >= 60) return 2;
  if (baseScore >= 35) return 1;
  return 0;
}

function timeAdjustedScore(message, nowSeconds) {
  const baseScore = Number.parseFloat(message.getStringProperty(SCORE_PROPERTY));
  if (!Number.isFinite(baseScore)) return 0;
  const ageHours = Math.max(0, nowSeconds - message.dateInSeconds) / 3600;
  return baseScore * Math.exp((-Math.log(2) * ageHours) / HALF_LIFE_HOURS);
}

function smartThreadKey(message) {
  const nowSeconds = Date.now() / 1000;
  let maximumPriority = priorityRank(message);
  let maximumAdjustedScore = timeAdjustedScore(message, nowSeconds);

  try {
    const thread = message.folder.msgDatabase.getThreadContainingMsgHdr(message);
    for (let index = 0; index < thread.numChildren; index += 1) {
      const child = thread.getChildHdrAt(index);
      const childPriority = priorityRank(child);
      const childScore = timeAdjustedScore(child, nowSeconds);
      if (childPriority > maximumPriority) {
        maximumPriority = childPriority;
        maximumAdjustedScore = childScore;
      } else if (childPriority === maximumPriority) {
        maximumAdjustedScore = Math.max(maximumAdjustedScore, childScore);
      }
    }
  } catch (error) {
    console.warn("Local Triage could not aggregate a message thread", error);
  }

  return (
    maximumPriority * PRIORITY_STEP +
    Math.round(maximumAdjustedScore * SCORE_SCALE)
  );
}

function ensureColumn() {
  if (!ThreadPaneColumns) return false;

  try {
    if (ThreadPaneColumns.getCustomColumns().some(({ id }) => id === COLUMN_ID)) {
      return true;
    }

    ThreadPaneColumns.addCustomColumn(COLUMN_ID, {
      name: "Smart priority + date",
      hidden: true,
      icon: false,
      resizable: false,
      sortable: true,
      textCallback: () => "",
      sortCallback: smartThreadKey,
    });
    return true;
  } catch (error) {
    disableSmartOrder(
      "Local Triage could not register Smart order; classification will continue",
      error,
    );
    return false;
  }
}

function getCurrentAbout3Pane() {
  const window = Services.wm.getMostRecentWindow("mail:3pane");
  return window?.document.getElementById("tabmail")?.currentAbout3Pane ?? null;
}

function activateCurrent() {
  if (!ensureColumn()) {
    throw new Error(
      "Smart ordering is unavailable in this Thunderbird version; classification remains active.",
    );
  }
  const about3Pane = getCurrentAbout3Pane();
  if (!about3Pane?.gViewWrapper?.dbView) return false;

  try {
    about3Pane.gViewWrapper.showThreaded = true;
    about3Pane.gViewWrapper.sort(
      COLUMN_ID,
      Ci.nsMsgViewSortOrder.descending,
    );
    about3Pane.threadPane?.restoreThreadState();
    about3Pane.threadPane?.updateSortIndicator(COLUMN_ID);
    return true;
  } catch (error) {
    disableSmartOrder(
      "Local Triage could not activate Smart order; classification will continue",
      error,
    );
    throw new Error(
      "Smart ordering is unavailable in this Thunderbird version; classification remains active.",
    );
  }
}

function refreshSortedViews() {
  if (!ensureColumn()) return false;
  try {
    ThreadPaneColumns.refreshCustomColumn(COLUMN_ID);

    for (const window of Services.wm.getEnumerator("mail:3pane")) {
      const tabmail = window.document.getElementById("tabmail");
      for (const tab of tabmail?.tabInfo ?? []) {
        const about3Pane = tab.chromeBrowser?.contentWindow;
        const view = about3Pane?.gViewWrapper;
        if (view?.primarySortColumnId !== COLUMN_ID) continue;

        view.sort(COLUMN_ID, Ci.nsMsgViewSortOrder.descending);
        about3Pane.threadPane?.restoreThreadState();
        about3Pane.threadPane?.updateSortIndicator(COLUMN_ID);
      }
    }
    return true;
  } catch (error) {
    disableSmartOrder(
      "Local Triage could not refresh Smart order; classification will continue",
      error,
    );
    return false;
  }
}

var smartOrder = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    ensureColumn();
    context.callOnClose(this);

    return {
      smartOrder: {
        async setScore(messageId, score) {
          try {
            const message = context.extension.messageManager.get(messageId);
            if (!message) return;

            const normalized = Math.max(0, Math.min(100, Number(score) || 0));
            message.setStringProperty(SCORE_PROPERTY, String(normalized));
            message.folder?.msgDatabase?.commit(
              Ci.nsMsgDBCommitType.kLargeCommit,
            );
          } catch (error) {
            console.warn(
              "Local Triage could not store a Smart order score; classification will continue",
              error,
            );
            return;
          }

          if (ensureColumn()) {
            try {
              ThreadPaneColumns.refreshCustomColumn(COLUMN_ID);
            } catch (error) {
              disableSmartOrder(
                "Local Triage could not refresh its Smart order column; classification will continue",
                error,
              );
            }
          }
        },
        async activateCurrent() {
          return activateCurrent();
        },
        async refresh() {
          refreshSortedViews();
        },
      },
    };
  }

  close() {
    if (!ThreadPaneColumns) return;
    try {
      if (ThreadPaneColumns.getCustomColumns().some(({ id }) => id === COLUMN_ID)) {
        ThreadPaneColumns.removeCustomColumn(COLUMN_ID);
      }
    } catch (error) {
      console.warn("Local Triage could not remove its Smart order column", error);
    }
  }
};
