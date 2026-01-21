/**
 * Tests for the CLI LLM client wrapper module.
 *
 * The CLI llmClient is now a thin wrapper around src/core/llm/client.ts.
 * Detailed tool handling tests are in src/core/llm/toolExecutor.test.ts.
 * These tests focus on the wrapper functionality and backward compatibility.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the core client module
vi.mock("../core/llm/client", () => {
  const mockChat = vi.fn();
  const mockContinueChat = vi.fn();
  const mockGenerateTitle = vi.fn();

  const mockCreateLLMClient = vi.fn(() => ({
    chat: mockChat,
    continueChat: mockContinueChat,
    generateTitle: mockGenerateTitle,
  }));

  // Expose mocks via static properties
  (mockCreateLLMClient as unknown as { mockChat: typeof mockChat }).mockChat = mockChat;
  (mockCreateLLMClient as unknown as { mockContinueChat: typeof mockContinueChat }).mockContinueChat = mockContinueChat;
  (mockCreateLLMClient as unknown as { mockGenerateTitle: typeof mockGenerateTitle }).mockGenerateTitle = mockGenerateTitle;

  return {
    createLLMClient: mockCreateLLMClient,
  };
});

import { createLLMClient as mockCreateLLMClient } from "../core/llm/client";
import { getSuggestion, continueConversation, generateTitle, createCliClient, LlmOptions } from "./llmClient";

// Get references to the mock functions
const mockChat = (mockCreateLLMClient as unknown as { mockChat: ReturnType<typeof vi.fn> }).mockChat;
const mockContinueChat = (mockCreateLLMClient as unknown as { mockContinueChat: ReturnType<typeof vi.fn> }).mockContinueChat;
const mockGenerateTitle = (mockCreateLLMClient as unknown as { mockGenerateTitle: ReturnType<typeof vi.fn> }).mockGenerateTitle;

// ============================================================================
// Test Helpers
// ============================================================================

const defaultOptions: LlmOptions = {
  devMode: true,
  model: "gpt-4o-mini",
};

// ============================================================================
// Tests
// ============================================================================

describe("llmClient (wrapper)", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original env
    originalEnv = { ...process.env };
    // Set API key for tests
    process.env.OPENAI_API_KEY = "test-api-key";
    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore original env
    process.env = originalEnv;
  });

  // ==========================================================================
  // createCliClient tests
  // ==========================================================================

  describe("createCliClient", () => {
    it("should create a client with the specified model", () => {
      createCliClient({ devMode: false, model: "gpt-5.2-2025-12-11" });

      expect(mockCreateLLMClient).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-5.2-2025-12-11",
        })
      );
    });

    it("should pass onProgress callback through", () => {
      const onProgress = vi.fn();
      createCliClient({ devMode: true, model: "gpt-4o-mini", onProgress });

      expect(mockCreateLLMClient).toHaveBeenCalledWith(
        expect.objectContaining({
          onProgress,
        })
      );
    });
  });

  // ==========================================================================
  // getSuggestion tests (backward compatibility)
  // ==========================================================================

  describe("getSuggestion (backward compatible)", () => {
    it("should call chat on the created client", async () => {
      mockChat.mockResolvedValueOnce({
        text: "Response text",
        model: "gpt-4o-mini",
        responseId: "resp_123",
      });

      const result = await getSuggestion("system prompt", "user prompt", defaultOptions);

      expect(mockChat).toHaveBeenCalledWith("system prompt", "user prompt");
      expect(result.text).toBe("Response text");
      expect(result.responseId).toBe("resp_123");
    });

    it("should throw when API key is missing", async () => {
      delete process.env.OPENAI_API_KEY;

      // The core client will throw, but we need to simulate that
      (mockCreateLLMClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error("OPENAI_API_KEY environment variable is not set");
      });

      await expect(
        getSuggestion("system", "user", defaultOptions)
      ).rejects.toThrow("OPENAI_API_KEY");
    });
  });

  // ==========================================================================
  // continueConversation tests (backward compatibility)
  // ==========================================================================

  describe("continueConversation (backward compatible)", () => {
    it("should call continueChat on the created client", async () => {
      mockContinueChat.mockResolvedValueOnce({
        text: "Continued response",
        model: "gpt-4o-mini",
        responseId: "resp_456",
      });

      const result = await continueConversation("follow up", "resp_123", defaultOptions);

      expect(mockContinueChat).toHaveBeenCalledWith("follow up", "resp_123");
      expect(result.text).toBe("Continued response");
      expect(result.responseId).toBe("resp_456");
    });
  });

  // ==========================================================================
  // generateTitle tests
  // ==========================================================================

  describe("generateTitle", () => {
    it("should call generateTitle on the client", async () => {
      mockGenerateTitle.mockResolvedValueOnce("Jack's Tarkir Analysis");

      const result = await generateTitle("resp_123");

      expect(mockGenerateTitle).toHaveBeenCalledWith("resp_123");
      expect(result).toBe("Jack's Tarkir Analysis");
    });

    it("should return 'Untitled' when API key is missing", async () => {
      delete process.env.OPENAI_API_KEY;

      const result = await generateTitle("resp_123");

      expect(result).toBe("Untitled");
    });

    it("should return 'Untitled' when client throws", async () => {
      (mockCreateLLMClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error("Some error");
      });

      const result = await generateTitle("resp_123");

      expect(result).toBe("Untitled");
    });
  });
});
