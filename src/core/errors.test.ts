import { describe, it, expect } from "vitest";
import { AppError, AuthError, ValidationError, NotFoundError, ConflictError } from "./errors";

describe("AppError", () => {
  it("sets message and statusCode", () => {
    const err = new AppError("something went wrong", 500);
    expect(err.message).toBe("something went wrong");
    expect(err.statusCode).toBe(500);
    expect(err.name).toBe("AppError");
  });

  it("is an instance of Error", () => {
    const err = new AppError("oops", 500);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("AuthError", () => {
  it("sets statusCode to 401", () => {
    const err = new AuthError("Missing seat token");
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe("Missing seat token");
    expect(err.name).toBe("AuthError");
  });

  it("is instanceof AppError and Error", () => {
    const err = new AuthError("Invalid seat token");
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("ValidationError", () => {
  it("sets statusCode to 400", () => {
    const err = new ValidationError("Invalid input");
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe("Invalid input");
    expect(err.name).toBe("ValidationError");
  });

  it("is instanceof AppError and Error", () => {
    const err = new ValidationError("bad value");
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("NotFoundError", () => {
  it("sets statusCode to 404", () => {
    const err = new NotFoundError("Draft not found");
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe("Draft not found");
    expect(err.name).toBe("NotFoundError");
  });

  it("is instanceof AppError and Error", () => {
    const err = new NotFoundError("missing resource");
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("ConflictError", () => {
  it("sets statusCode to 409", () => {
    const err = new ConflictError("Conflict: pick_n already exists — retry");
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe("Conflict: pick_n already exists — retry");
    expect(err.name).toBe("ConflictError");
  });

  it("is instanceof AppError and Error", () => {
    const err = new ConflictError("conflict");
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
  });
});
