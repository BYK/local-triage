function headerValue(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value ?? "";
}

function basicHtmlToText(html) {
  if (typeof DOMParser !== "undefined") {
    const document = new DOMParser().parseFromString(html, "text/html");
    return document.body?.textContent ?? "";
  }
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

export function cleanBody(text) {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => !/^>/.test(line.trim()))
    .join("\n")
    .split(/\nOn .{0,180}wrote:\s*\n/i)[0]
    .split(/\n--\s*\n/)[0]
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readableBody(messageId) {
  const parts = await messenger.messages.listInlineTextParts(messageId);
  const plain = parts.filter((part) => part.contentType === "text/plain");
  const selected = plain.length ? plain : parts.filter((part) => part.contentType === "text/html");
  const chunks = [];

  for (const part of selected) {
    if (part.contentType === "text/html") {
      try {
        chunks.push(await messenger.utilities.convertToPlainText(part.content));
      } catch {
        chunks.push(basicHtmlToText(part.content));
      }
    } else {
      chunks.push(part.content);
    }
  }
  return cleanBody(chunks.join("\n\n"));
}

let ownAddressesPromise;

async function ownAddresses() {
  if (!ownAddressesPromise) {
    ownAddressesPromise = messenger.accounts.list().then((accounts) =>
      new Set(
        accounts.flatMap((account) =>
          (account.identities ?? [])
            .map((identity) => identity.email?.toLowerCase())
            .filter(Boolean),
        ),
      ),
    );
  }
  return ownAddressesPromise;
}

function mailboxAddress(mailbox) {
  const match = String(mailbox).match(/<([^>]+)>/);
  return (match?.[1] ?? mailbox).trim().toLowerCase();
}

export async function extractMessage(header) {
  const [full, body, addresses] = await Promise.all([
    messenger.messages.getFull(header.id, { decrypt: true }),
    readableBody(header.id),
    ownAddresses(),
  ]);
  const recipients = [...(header.recipients ?? []), ...(header.ccList ?? [])];
  const ownRecipientCount = recipients.filter((recipient) =>
    addresses.has(mailboxAddress(recipient)),
  ).length;

  return {
    id: header.id,
    headerMessageId: header.headerMessageId,
    folder: header.folder,
    author: header.author,
    recipients,
    subject: header.subject,
    date: header.date,
    flagged: header.flagged,
    read: header.read,
    body,
    directRecipient: ownRecipientCount > 0 && recipients.length <= 3,
    headers: {
      listUnsubscribe: headerValue(full.headers, "list-unsubscribe"),
      precedence: headerValue(full.headers, "precedence"),
      autoSubmitted: headerValue(full.headers, "auto-submitted"),
      inReplyTo: headerValue(full.headers, "in-reply-to"),
      priority: header.priority ?? headerValue(full.headers, "x-priority"),
    },
  };
}

export async function collectMessageList(initialList) {
  const messages = [...(initialList?.messages ?? [])];
  let listId = initialList?.id;
  while (listId) {
    const next = await messenger.messages.continueList(listId);
    messages.push(...(next.messages ?? []));
    listId = next.id;
  }
  return messages;
}

