export const DEFAULT_CATEGORIES = [
  {
    name: "Action",
    description:
      "A direct request, question, approval, decision, task, deadline, or message that needs my response or action.",
    color: "#D9485F",
  },
  {
    name: "Work",
    description:
      "Work correspondence about projects, engineering, colleagues, customers, meetings, planning, or professional matters.",
    color: "#4A78D0",
  },
  {
    name: "Personal",
    description:
      "Personal correspondence from friends, family, school, community, or other people in my private life.",
    color: "#9B59B6",
  },
  {
    name: "Finance",
    description:
      "Banking, payments, invoices, receipts, tax, insurance, subscriptions, purchases, investments, pensions, funds, or other financial matters.",
    color: "#168A65",
  },
  {
    name: "Travel",
    description:
      "Travel bookings, tickets, reservations, hotels, transport, itineraries, visas, or delivery and arrival details.",
    color: "#D97706",
  },
  {
    name: "Newsletter",
    description:
      "A newsletter, marketing campaign, promotion, product announcement, digest, or other bulk informational email.",
    color: "#7A7F87",
  },
  {
    name: "Notification",
    description:
      "An automated status update, system alert, social notification, authentication message, or routine service notification.",
    color: "#008C99",
  },
];

export const PRIORITIES = [
  { key: "P0", name: "Urgent", color: "#C62828", minimum: 80 },
  { key: "P1", name: "Important", color: "#E87500", minimum: 60 },
  { key: "P2", name: "Normal", color: "#3974C6", minimum: 35 },
  { key: "P3", name: "Low", color: "#777777", minimum: 0 },
];

export const DEFAULT_SETTINGS = {
  enabled: true,
  useEmbeddings: true,
  starUrgent: false,
  modelId: "Xenova/multilingual-e5-small",
  modelDtype: "q8",
  categories: DEFAULT_CATEGORIES,
  minimumCategoryConfidence: 0.3,
  maximumBodyCharacters: 2400,
};

export const REVIEW_TAG = {
  key: "localtriage-review",
  name: "✦ Review",
  color: "#A05A00",
};

export const EVENT_TAG = {
  key: "localtriage-event",
  name: "✦ Event",
  color: "#6A5ACD",
};
