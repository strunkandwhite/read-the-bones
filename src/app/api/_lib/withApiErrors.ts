import { NextResponse } from "next/server";
import { AppError } from "@/core/errors";

type Handler<TArgs extends unknown[]> = (...args: TArgs) => Promise<NextResponse>;

/**
 * Wraps a route handler with standard error handling:
 * - AppError subclasses (AuthError, ValidationError, etc.) → their status code + message
 * - Everything else → console.error(label, err) + generic 500
 *
 * The wrapper is transparent to success paths and preserves every route's
 * existing response shape exactly.
 */
export function withApiErrors<TArgs extends unknown[]>(
  handler: Handler<TArgs>,
  label: string,
): Handler<TArgs> {
  return async (...args: TArgs): Promise<NextResponse> => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof AppError) {
        return NextResponse.json({ error: error.message }, { status: error.statusCode });
      }
      console.error(label, error);
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
