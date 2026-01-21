"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import { CardLink } from "./CardLink";

/**
 * Replace [[Card Name]] with card-link HTML elements.
 */
function processCardLinks(text: string): string {
  return text.replace(
    /\[\[([^\]]+)\]\]/g,
    '<card-link name="$1">$1</card-link>'
  );
}

/**
 * Replace [1], [2], etc. with superscript citations.
 * Avoids matching markdown links [text](url) or reference definitions [1]: url.
 */
function processCitations(text: string): string {
  return text.replace(
    /\[(\d+)\](?!\(|:)/g,
    '<sup class="cite">$1</sup>'
  );
}

/**
 * Generate a unique message ID.
 */
let messageIdCounter = 0;
function generateMessageId(): string {
  return `msg-${Date.now()}-${++messageIdCounter}`;
}

/**
 * Message in the conversation history.
 */
interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

/**
 * Response from the /api/chat endpoint.
 */
interface ChatResponse {
  text: string;
  responseId: string;
  model: string;
}

/**
 * Error response from the /api/chat endpoint.
 */
interface ErrorResponse {
  error: string;
}

export interface QueryBoxProps {
  /** Optional placeholder text for the input */
  placeholder?: string;
}

/**
 * Chat UI component for querying draft data using natural language.
 *
 * Features:
 * - Text input for user questions
 * - Conversation history with user and assistant messages
 * - Conversation continuation via responseId
 * - Loading state while waiting for response
 * - Error handling with user-friendly messages
 * - Clear button to start a new conversation
 */
export function QueryBox({
  placeholder = "Ask about drafts, picks, or player stats...",
}: QueryBoxProps) {
  // Conversation state
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [responseId, setResponseId] = useState<string | null>(null);

  // Refs for auto-scrolling
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const lastUserMessageRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Scroll so the last user message is near the top when messages change
  useEffect(() => {
    const container = messagesContainerRef.current;
    const lastUserMessage = lastUserMessageRef.current;
    if (container && lastUserMessage) {
      const containerRect = container.getBoundingClientRect();
      const messageRect = lastUserMessage.getBoundingClientRect();
      // Calculate how far the message is from the container's top edge
      const visibleOffset = messageRect.top - containerRect.top;
      // Adjust scroll to bring the message near the top with padding
      const topPadding = 16;
      container.scrollTop += visibleOffset - topPadding;
    }
  }, [messages]);

  // Auto-resize textarea to fit content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }, [inputValue]);

  /**
   * Send a message to the chat API.
   */
  const sendMessage = useCallback(async () => {
    const trimmedInput = inputValue.trim();
    if (!trimmedInput || isLoading) return;

    // Add user message to history
    const userMessage: Message = {
      id: generateMessageId(),
      role: "user",
      content: trimmedInput,
    };
    setMessages((prev) => [...prev, userMessage]);
    setInputValue("");
    setError(null);
    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmedInput,
          ...(responseId && { previousResponseId: responseId }),
        }),
      });

      const data: ChatResponse | ErrorResponse = await response.json();

      if (!response.ok) {
        const errorData = data as ErrorResponse;
        throw new Error(errorData.error || "Request failed");
      }

      const successData = data as ChatResponse;

      // Add assistant message to history
      const assistantMessage: Message = {
        id: generateMessageId(),
        role: "assistant",
        content: successData.text,
      };
      setMessages((prev) => [...prev, assistantMessage]);

      // Store responseId for conversation continuation
      setResponseId(successData.responseId);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "An unexpected error occurred";
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  }, [inputValue, isLoading, responseId]);

  /**
   * Handle form submission.
   */
  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      sendMessage();
    },
    [sendMessage]
  );

  /**
   * Handle keyboard shortcuts.
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Submit on Enter (without Shift for multiline support)
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage]
  );

  /**
   * Clear conversation and start fresh.
   */
  const clearConversation = useCallback(() => {
    setMessages([]);
    setError(null);
    setResponseId(null);
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Messages area */}
      <div
        ref={messagesContainerRef}
        role="log"
        aria-live="polite"
        aria-busy={isLoading}
        className="flex-1 overflow-y-auto p-4"
      >
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-center text-sm text-zinc-400 dark:text-zinc-500">
              Ask questions about past drafts, like &quot;what&apos;s the
              highest-picked blue card?&quot; or &quot;what does a successful
              Gx ramp deck look like?&quot;
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((message, index) => {
              // Find if this is the last user message
              const isLastUserMessage =
                message.role === "user" &&
                !messages.slice(index + 1).some((m) => m.role === "user");

              return (
              <div
                key={message.id}
                ref={isLastUserMessage ? lastUserMessageRef : undefined}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-4 py-2 ${
                    message.role === "user"
                      ? "bg-zinc-200 text-zinc-900 dark:bg-zinc-600 dark:text-zinc-100"
                      : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                  }`}
                >
                  {message.role === "user" ? (
                    <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                  ) : (
                    <div className="prose prose-sm prose-zinc dark:prose-invert max-w-none">
                      <ReactMarkdown
                        rehypePlugins={[rehypeRaw]}
                        components={
                          {
                            "card-link": ({
                              name,
                            }: {
                              name?: string;
                            }) => <CardLink name={name ?? ""} />,
                          } as Record<string, React.ComponentType<{ name?: string }>>
                        }
                      >
                        {processCitations(processCardLinks(message.content))}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>
              </div>
              );
            })}

            {/* Loading indicator */}
            {isLoading && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-lg bg-zinc-100 px-4 py-2 dark:bg-zinc-800">
                  <div className="flex items-center gap-1">
                    <div className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-500" />
                    <div
                      className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-500"
                      style={{ animationDelay: "0.1s" }}
                    />
                    <div
                      className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 dark:bg-zinc-500"
                      style={{ animationDelay: "0.2s" }}
                    />
                  </div>
                </div>
              </div>
            )}

          </div>
        )}
      </div>

      {/* Error display */}
      {error && (
        <div className="border-t border-red-200 bg-red-50 px-4 py-2 dark:border-red-900 dark:bg-red-950">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Input area */}
      <form
        onSubmit={handleSubmit}
        className="border-t border-zinc-200 p-4 dark:border-zinc-700"
      >
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={isLoading}
            rows={1}
            aria-label="Ask a question about draft data"
            className="max-h-40 flex-1 resize-none overflow-hidden rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 placeholder-zinc-500 focus:border-transparent focus:ring-2 focus:ring-zinc-400 focus:outline-none disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder-zinc-400 dark:focus:ring-zinc-500"
          />
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clearConversation}
              aria-label="Clear conversation"
              className="cursor-pointer rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-2 focus:outline-none dark:border-zinc-600 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:focus:ring-zinc-500 dark:focus:ring-offset-zinc-900"
            >
              Clear
            </button>
          )}
          <button
            type="submit"
            disabled={!inputValue.trim() || isLoading}
            className="cursor-pointer rounded-lg bg-zinc-200 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-300 focus:ring-2 focus:ring-zinc-400 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-600 dark:text-zinc-100 dark:hover:bg-zinc-500 dark:focus:ring-zinc-500 dark:focus:ring-offset-zinc-900"
          >
            {isLoading ? "..." : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}
