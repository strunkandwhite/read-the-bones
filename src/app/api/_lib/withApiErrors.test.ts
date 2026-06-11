import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "./withApiErrors";
import { AppError, AuthError, ValidationError, NotFoundError } from "@/core/errors";

function makeRequest() {
  return new NextRequest(new URL("http://localhost:3000/api/test"));
}

describe("withApiErrors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("passes through a successful response unchanged", async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = withApiErrors(handler, "[test]");

    const res = await wrapped(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("maps AppError to its status code and message", async () => {
    const handler = vi.fn().mockRejectedValue(new AppError("Custom error", 422));
    const wrapped = withApiErrors(handler, "[test]");

    const res = await wrapped(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe("Custom error");
  });

  it("maps AuthError (AppError subclass) to 401", async () => {
    const handler = vi.fn().mockRejectedValue(new AuthError("Unauthorized"));
    const wrapped = withApiErrors(handler, "[test]");

    const res = await wrapped(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("maps ValidationError (AppError subclass) to 400", async () => {
    const handler = vi.fn().mockRejectedValue(new ValidationError("Bad input"));
    const wrapped = withApiErrors(handler, "[test]");

    const res = await wrapped(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Bad input");
  });

  it("maps NotFoundError (AppError subclass) to 404", async () => {
    const handler = vi.fn().mockRejectedValue(new NotFoundError("Not found"));
    const wrapped = withApiErrors(handler, "[test]");

    const res = await wrapped(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Not found");
  });

  it("maps unknown errors to 500 with generic message", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("DB exploded"));
    const wrapped = withApiErrors(handler, "[test]");

    const res = await wrapped(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Internal server error");
  });

  it("logs unknown errors with the provided label", async () => {
    const err = new Error("DB exploded");
    const handler = vi.fn().mockRejectedValue(err);
    const wrapped = withApiErrors(handler, "[/api/things] Error:");

    await wrapped(makeRequest());

    expect(console.error).toHaveBeenCalledWith("[/api/things] Error:", err);
  });

  it("does not log AppErrors", async () => {
    const handler = vi.fn().mockRejectedValue(new AppError("expected error", 400));
    const wrapped = withApiErrors(handler, "[test]");

    await wrapped(makeRequest());

    expect(console.error).not.toHaveBeenCalled();
  });

  it("forwards all arguments to the handler", async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = withApiErrors(handler, "[test]");
    const req = makeRequest();
    const ctx = { params: Promise.resolve({ id: "123" }) };

    await wrapped(req, ctx);

    expect(handler).toHaveBeenCalledWith(req, ctx);
  });
});
