type MessageNode = Record<string, unknown>;

export const CLIENT_MESSAGE_PATHS = [
  "claim",
  "collectionActionMenu",
  "collectionDetail",
  "collectionEditor",
  "commandLine",
  "common",
  "feedback",
  "feedback.kinds",
  "feedbackThread",
  "feedbackThread.status",
  "footer",
  "gallery",
  "galleryReorder",
  "header",
  "home.surprise",
  "installCommand",
  "installCompact",
  "installCompact.themeDialog",
  "leaderboard",
  "myFeedback.filters",
  "myPets",
  "myPets.claimBanner",
  "myPets.edit",
  "notifications",
  "onboarding",
  "openInCodex",
  "desktopAnnounce",
  "downloadHero",
  "openInPetdex",
  "ownerCollections",
  "pet.counters",
  "pet.floater",
  "petActions",
  "petStateViewer",
  "pinnedReorder",
  "profile",
  "profileEditor",
  "profileEditor.errors",
  "profileShare",
  "profileTabs",
  "requests.view",
  "sticker",
  "stickers",
  "submit.form",
  "submit.form.copy",
  "submit.form.preview",
  "submit.form.submitButton",
  "submit.form.success",
  "submittedBy",
  "suggestCollection",
  "theme",
  "unsubscribePage.form",
] as const;

export function pickClientMessages<T extends MessageNode>(
  messages: T,
): Partial<T> {
  const picked: MessageNode = {};

  for (const path of CLIENT_MESSAGE_PATHS) {
    copyPath(messages as MessageNode, picked, path.split("."));
  }

  return picked as Partial<T>;
}

function copyPath(source: MessageNode, target: MessageNode, parts: string[]) {
  let sourceCursor: unknown = source;
  let targetCursor = target;

  for (const [index, part] of parts.entries()) {
    if (!isMessageNode(sourceCursor) || !(part in sourceCursor)) return;
    const sourceValue = sourceCursor[part];

    if (index === parts.length - 1) {
      targetCursor[part] = sourceValue;
      return;
    }

    const targetValue = targetCursor[part];
    if (!isMessageNode(targetValue)) {
      targetCursor[part] = {};
    }

    targetCursor = targetCursor[part] as MessageNode;
    sourceCursor = sourceValue;
  }
}

function isMessageNode(value: unknown): value is MessageNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
