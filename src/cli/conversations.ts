/**
 * Conversation persistence for resuming LLM sessions.
 */

import { randomUUID } from "crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import type { Conversation, ConversationStore } from "./types";

/** Default path for conversation storage */
export const DEFAULT_CONVERSATIONS_PATH = "src/cli/conversations.json";

/**
 * Load conversations from disk.
 * Returns empty store if file doesn't exist.
 * Backs up and resets if JSON is corrupted.
 */
export function loadConversations(path: string = DEFAULT_CONVERSATIONS_PATH): ConversationStore {
  if (!existsSync(path)) {
    return { conversations: [] };
  }

  try {
    const content = readFileSync(path, "utf-8");
    return JSON.parse(content) as ConversationStore;
  } catch {
    // Backup corrupted file and start fresh
    console.warn(`Warning: Corrupted conversations file, backing up to ${path}.bak`);
    renameSync(path, path + ".bak");
    return { conversations: [] };
  }
}

/**
 * Save conversations to disk.
 */
export function saveConversations(
  store: ConversationStore,
  path: string = DEFAULT_CONVERSATIONS_PATH
): void {
  writeFileSync(path, JSON.stringify(store, null, 2));
}

/**
 * Create a new conversation.
 */
export function createConversation(
  mode: "explore" | "draft",
  initialResponseId: string,
  draftPath?: string
): Conversation {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: "Untitled",
    mode,
    ...(draftPath && { draftPath }),
    responseIds: [initialResponseId],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Add a response ID to a conversation and update timestamp.
 */
export function addResponseId(conversation: Conversation, responseId: string): Conversation {
  return {
    ...conversation,
    responseIds: [...conversation.responseIds, responseId],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Get the latest response ID for resuming.
 */
export function getLatestResponseId(conversation: Conversation): string {
  return conversation.responseIds[conversation.responseIds.length - 1];
}

/**
 * List conversations sorted by most recent first.
 */
export function listConversations(store: ConversationStore): Conversation[] {
  return [...store.conversations].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}
