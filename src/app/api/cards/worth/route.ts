import { NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

// The worth table is dev-only tooling and disabled in production.
// Using an env check rather than trusting the client-supplied Host header, which
// can be spoofed and also appears in server/CDN logs when used for auth decisions.
const WORTH_ENABLED = process.env.NODE_ENV !== "production";

export const GET = withApiErrors(async () => {
  if (!WORTH_ENABLED) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // No cache-control header: dev-only, always fresh (the query layer memoizes).
  const { cards, model, computedAt, cardsFit } = await queries.getWorthTable();

  // Model keys are snake_cased at this boundary — the MCP tool and skill
  // consume snake_case per the worth-model spec.
  return NextResponse.json({
    cards,
    model: {
      a: model.a,
      b: model.b,
      tau: model.tau,
      sigma: model.sigma,
      tau_a: model.tauA,
      kappa: model.kappa,
      grand_mean: model.grandMean,
      baselines: model.baselines,
      pair_edges: model.pairEdges,
    },
    cards_fit: cardsFit,
    computed_at: computedAt,
  });
}, "[/api/cards/worth] Error:");
