"use client";

import { useEffect } from "react";
import { useCardStats } from "@/app/hooks/useCardStats";
import { HoldToPickButton } from "./HoldToPickButton";
import { DistributionHistogram } from "./DistributionHistogram";
import { Sparkline } from "./Sparkline";
import type { DraftScore } from "@/core/types";

type CardStatus = "picked" | "queued" | "floated" | "none" | "taken";

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
};

export function CardStatsModal(props: CardStatsModalProps) {
  const { cardName, isOpen, onClose, draftId, isLocal } = props;
  const { data, loading } = useCardStats(isOpen ? cardName : null, draftId);

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
        className="mx-4 max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-gray-900"
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
            <h2 className="mb-3 text-lg font-semibold text-white">{cardName}</h2>
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

// --- Stats content ---

type StatsData = NonNullable<ReturnType<typeof useCardStats>["data"]>;

function StatsContent({ data, isLocal }: { data: StatsData; isLocal?: boolean }) {
  const { pick, wins, pick_history, pick_distribution, color_pair_breakdown } = data;

  // Transform pick_history to DraftScore[] for Sparkline
  const sparklineHistory: DraftScore[] = pick_history.map((h) => ({
    draftId: h.draftId,
    date: h.draftDate,
    draftName: h.draftName,
    pickPosition: h.pickPosition,
    wasPicked: h.picked,
    numDrafters: 10, // default; not available from stats API
    round: Math.ceil(h.pickPosition / 10),
  }));

  return (
    <div className="space-y-4">
      {/* Key stats */}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <StatRow label="Pick Score" value={pick.geomean_pick.toFixed(1)} />
        <StatRow label="Picked" value={`${pick.times_picked} / ${pick.drafts_in_pool}`} />
        <StatRow label="Avg Pick" value={pick.avg_pick.toFixed(1)} />
        <StatRow label="Median Pick" value={pick.median_pick.toFixed(0)} />
        {isLocal && wins && (
          <StatRow
            label="GPWR"
            value={
              wins.low_sample
                ? `${(wins.win_rate * 100).toFixed(0)}%*`
                : `${(wins.win_rate * 100).toFixed(0)}%`
            }
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
                className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-200"
              >
                <span className="font-medium">{cp.colorPair}</span>
                <span className="text-zinc-400">{cp.percentage}%</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Distribution histogram */}
      <div>
        <div className="mb-1.5 text-xs font-medium text-zinc-400">Pick Distribution</div>
        <DistributionHistogram distribution={pick_distribution} />
      </div>

      {/* Sparkline */}
      {sparklineHistory.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs font-medium text-zinc-400">Draft History</div>
          <Sparkline history={sparklineHistory} />
        </div>
      )}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-zinc-400">{label}</div>
      <div className="font-medium text-white">{value}</div>
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
              className="w-full rounded-lg bg-blue-700 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-600"
              onClick={props.onQueue}
            >
              Queue
            </button>
          )}
          {props.onFloat && (
            <button
              className="w-full rounded-lg bg-zinc-700 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-600"
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
              className="w-full rounded-lg bg-zinc-700 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-600"
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
              className="w-full rounded-lg bg-blue-700 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-600"
              onClick={props.onQueue}
            >
              Queue
            </button>
          )}
          {props.onUnfloat && (
            <button
              className="w-full rounded-lg bg-zinc-700 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-600"
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
