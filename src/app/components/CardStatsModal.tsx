"use client";

import { useEffect } from "react";
import { useCardStats } from "@/app/hooks/useCardStats";
import { HoldToPickButton } from "./HoldToPickButton";
import { DistributionHistogram } from "./DistributionHistogram";
import { Sparkline } from "./Sparkline";
import { ColorPills } from "./ManaSymbols";
import type { DraftScore } from "@/core/types";

import type { CardStatus } from "@/core/cardStatus";

type CardStatsModalProps = {
  cardName: string | null;
  scryfallImageUrl?: string;
  isOpen: boolean;
  onClose: () => void;
  draftId?: string;
  // Live draft action props (all optional — absent means stats-only)
  isLiveDraft?: boolean;
  isMyTurn?: boolean;
  cardStatus?: CardStatus;
  queuePosition?: number;
  onPick?: () => void;
  onQueue?: () => void;
  onUnqueue?: () => void;
  onFloat?: () => void;
  onUnfloat?: () => void;
  isLocal?: boolean;
  excludeDraftId?: string;
};

export function CardStatsModal(props: CardStatsModalProps) {
  const { cardName, isOpen, onClose, draftId, isLocal, excludeDraftId } = props;
  const { data, loading } = useCardStats(isOpen ? cardName : null, draftId, excludeDraftId);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  if (!isOpen || !cardName) return null;

  // Determine which action buttons to show
  const showActions =
    props.isLiveDraft && props.cardStatus !== "taken" && props.cardStatus !== "picked";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="mx-4 max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-zinc-800 shadow-2xl"
        style={{ background: "#1a1917" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-5 p-5 sm:flex-row">
          {/* Left / Top: Card image + actions */}
          <div className="shrink-0 sm:w-[220px]">
            {props.scryfallImageUrl && (
              <img
                src={props.scryfallImageUrl}
                alt={cardName}
                width={220}
                height={308}
                className="mx-auto w-[180px] rounded-lg sm:w-[220px]"
              />
            )}
            {showActions && (
              <div className="mt-3 flex flex-col gap-2">
                <ActionButtons {...props} />
              </div>
            )}
          </div>

          {/* Right / Bottom: Stats */}
          <div className="min-w-0 flex-1">
            {loading ? (
              <div className="text-sm text-gray-500">Loading stats...</div>
            ) : data ? (
              <StatsContent data={data} isLocal={isLocal} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Helpers ---

/** WUBRG-tinted backgrounds for color pair pills */
const WUBRG_BG: Record<string, string> = {
  W: "rgba(248,231,185,0.15)",
  U: "rgba(14,104,171,0.20)",
  B: "rgba(130,100,160,0.20)",
  R: "rgba(211,32,42,0.18)",
  G: "rgba(0,115,62,0.18)",
  C: "rgba(200,200,200,0.10)",
};

function colorPairBg(pair: string): string {
  const first = pair[0];
  return WUBRG_BG[first] ?? WUBRG_BG.C;
}

/** Aggregate same-date drafts into a single sparkline point using geometric mean */
function aggregateByDate(
  history: StatsData["pick_history"],
): DraftScore[] {
  // Group entries by date
  const byDate = new Map<string, StatsData["pick_history"]>();
  for (const h of history) {
    const group = byDate.get(h.draftDate) ?? [];
    group.push(h);
    byDate.set(h.draftDate, group);
  }

  const result: DraftScore[] = [];
  for (const [date, entries] of byDate) {
    if (entries.length === 1) {
      const h = entries[0];
      result.push({
        draftId: h.draftId,
        date,
        draftName: h.draftName,
        pickPosition: h.pickPosition,
        wasPicked: h.picked,
        numDrafters: h.numSeats,
        round: Math.ceil(h.pickPosition / h.numSeats),
      });
    } else {
      // Aggregate: geometric mean of pick positions
      const logSum = entries.reduce((sum, h) => sum + Math.log(Math.max(1, h.pickPosition)), 0);
      const geomean = Math.round(Math.exp(logSum / entries.length));
      const pickedCount = entries.filter((h) => h.picked).length;
      const avgSeats = Math.round(
        entries.reduce((sum, h) => sum + h.numSeats, 0) / entries.length,
      );
      result.push({
        draftId: entries[0].draftId,
        date,
        draftName: `${entries.length} drafts`,
        pickPosition: geomean,
        wasPicked: pickedCount > 0,
        numDrafters: avgSeats,
        round: Math.ceil(geomean / avgSeats),
        pickedCount,
        totalCount: entries.length,
      });
    }
  }
  return result;
}

// --- Stats content ---

type StatsData = NonNullable<ReturnType<typeof useCardStats>["data"]>;

function StatsContent({ data, isLocal }: { data: StatsData; isLocal?: boolean }) {
  const { pick, wins, pick_history, pick_distribution, times_banned, color_pair_breakdown } = data;

  // Transform pick_history to DraftScore[], aggregating same-date drafts
  const sparklineHistory: DraftScore[] = aggregateByDate(pick_history);

  return (
    <div className="space-y-4">
      {/* Key stats */}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <StatRow label="Pick Score" value={pick.geomean_pick.toFixed(1)} />
        <StatRow
          label="Picked"
          value={`${pick.times_picked} / ${pick_history.length}`}
          annotation={times_banned > 0 ? `banned ${times_banned}x` : undefined}
        />
        {isLocal && wins && (
          <StatRow
            label="GPWR"
            value={`${(wins.win_rate * 100).toFixed(0)}%`}
            annotation={`\u00b1${Math.round((wins.win_rate_ci.upper - wins.win_rate_ci.lower) * 50)}%`}
          />
        )}
      </div>

      {/* Color pair breakdown */}
      {color_pair_breakdown.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-medium text-zinc-400">Deck Colors</div>
          <div className="flex flex-wrap gap-1.5">
            {color_pair_breakdown.map((cp) => (
              <span
                key={cp.colorPair}
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs"
                style={{ backgroundColor: colorPairBg(cp.colorPair) }}
              >
                <ColorPills colors={cp.colorPair.split("")} />
                <span className="text-zinc-300">{cp.percentage}%</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Charts side-by-side */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-1.5 text-xs font-medium text-zinc-400">Pick Distribution</div>
          <DistributionHistogram distribution={pick_distribution} />
        </div>
        {sparklineHistory.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-medium text-zinc-400">Draft History</div>
            <Sparkline history={sparklineHistory} />
          </div>
        )}
      </div>
    </div>
  );
}

function StatRow({ label, value, annotation }: { label: string; value: string; annotation?: string }) {
  return (
    <div>
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="font-medium text-white">
        {value}
        {annotation && (
          <span className="ml-1 text-xs font-normal text-zinc-500">({annotation})</span>
        )}
      </div>
    </div>
  );
}

// --- Action buttons per card state ---

function ActionButtons(props: CardStatsModalProps) {
  const { cardStatus, isMyTurn } = props;

  switch (cardStatus) {
    case "none":
      return (
        <>
          {isMyTurn && props.onPick && <HoldToPickButton onPick={props.onPick} />}
          {props.onQueue && (
            <button
              className="w-full cursor-pointer rounded-lg bg-amber-700 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-amber-600"
              onClick={props.onQueue}
            >
              Queue
            </button>
          )}
          {props.onFloat && (
            <button
              className="w-full cursor-pointer rounded-lg bg-zinc-700 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-600"
              onClick={props.onFloat}
            >
              Float
            </button>
          )}
        </>
      );

    case "queued":
      return (
        <>
          {isMyTurn && props.onPick && <HoldToPickButton onPick={props.onPick} />}
          {props.onUnqueue && (
            <button
              className="w-full cursor-pointer rounded-lg bg-zinc-700 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-600"
              onClick={props.onUnqueue}
            >
              Unqueue{props.queuePosition != null ? ` (#${props.queuePosition})` : ""}
            </button>
          )}
        </>
      );

    case "floated":
      return (
        <>
          {isMyTurn && props.onPick && <HoldToPickButton onPick={props.onPick} />}
          {props.onQueue && (
            <button
              className="w-full cursor-pointer rounded-lg bg-amber-700 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-amber-600"
              onClick={props.onQueue}
            >
              Queue
            </button>
          )}
          {props.onUnfloat && (
            <button
              className="w-full cursor-pointer rounded-lg bg-zinc-700 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-600"
              onClick={props.onUnfloat}
            >
              Unfloat
            </button>
          )}
        </>
      );

    default:
      return null;
  }
}
