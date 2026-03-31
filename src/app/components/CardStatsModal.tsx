"use client";

import { useEffect, useMemo, useCallback, useState, useRef } from "react";
import { useCardStore } from "@/app/stores/cardStore";
import { useDraftStore } from "@/app/stores/draftStore";
import { useLiveStore } from "@/app/stores/liveStore";
import { getCardStatus, getImageUrl, useIsAuthed } from "@/app/stores/selectors";
import { isLocalClient } from "@/core/isLocal";
import type { CardStatsData } from "@/app/stores/cardStore";
import { HoldToPickButton } from "./HoldToPickButton";
import { DistributionHistogram } from "./DistributionHistogram";
import { Sparkline } from "./Sparkline";
import { ColorPills } from "./ManaSymbols";
import type { DraftScore } from "@/core/types";

import type { CardStatus } from "@/core/cardStatus";

export function CardStatsModal() {
  // Card store
  const selectedCard = useCardStore((s) => s.selectedCard);
  const clearSelectedCard = useCardStore((s) => s.clearSelectedCard);
  const data = useCardStore((s) => s.cardStatsDetail);
  const loading = useCardStore((s) => s.cardStatsLoading);

  // Draft store
  const activeDraft = useDraftStore((s) => s.activeDraft);
  const liveDraftStatus = useDraftStore((s) => s.liveDraftStatus);

  // Live store
  const isMyTurn = useLiveStore((s) => s.isMyTurn);
  const queue = useLiveStore((s) => s.queue);
  const autoPick = useLiveStore((s) => s.autoPick);
  const submitPick = useLiveStore((s) => s.handlePick);
  const addToQueue = useLiveStore((s) => s.addToQueue);
  const removeFromQueue = useLiveStore((s) => s.removeFromQueue);
  const addFloat = useLiveStore((s) => s.addFloat);
  const removeFloat = useLiveStore((s) => s.removeFloat);

  const isAuthed = useIsAuthed();
  const isOpen = !!selectedCard;
  const isLocal = useMemo(() => isLocalClient(), []);
  const isLiveDraft = !!activeDraft && liveDraftStatus?.phase === "drafting";

  const scryfallImageUrl = useMemo(
    () => getImageUrl(selectedCard),
    [selectedCard]
  );

  // Subscribe to the store values that getCardStatus reads internally,
  // so the status recomputes when queue/float state changes
  const queuedCardCounts = useLiveStore((s) => s.queuedCardCounts);
  const floatedCardsSet = useLiveStore((s) => s.floatedCardsSet);
  const seatCardNames = useCardStore((s) => s.seatCardNames);
  const takenCardNamesSet = useCardStore((s) => s.takenCardNamesSet);
  const takenCardCounts = useCardStore((s) => s.takenCardCounts);
  const cardData = useCardStore((s) => s.cardData);

  // getCardStatus reads from stores imperatively — these subscriptions
  // ensure the memo recomputes when the underlying data changes
  const cardStatusResult = useMemo(
    () => selectedCard ? getCardStatus(selectedCard) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedCard, isAuthed, queuedCardCounts, floatedCardsSet, seatCardNames, takenCardNamesSet, takenCardCounts, cardData]
  );

  const cardStatus: CardStatus = cardStatusResult?.status ?? "none";
  const queuePosition = cardStatusResult?.queuePosition;
  const queuedCount = cardStatusResult?.queuedCount;
  const remainingCopies = cardStatusResult?.remainingCopies;

  // Disable buttons briefly after any action to prevent double-clicks.
  // Re-enables after the server confirms (cardStatus changes) or 600ms, whichever is later.
  const [actionPending, setActionPending] = useState(false);
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minimumElapsedRef = useRef(false);

  // When cardStatus changes AND minimum time has elapsed, re-enable
  useEffect(() => {
    if (actionPending && minimumElapsedRef.current) {
      setActionPending(false);
      minimumElapsedRef.current = false;
    }
  }, [cardStatus, queuePosition]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setActionPending(false);
    minimumElapsedRef.current = false;
    if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
  }, [selectedCard]);

  const startAction = useCallback(() => {
    setActionPending(true);
    minimumElapsedRef.current = false;
    if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
    actionTimerRef.current = setTimeout(() => {
      minimumElapsedRef.current = true;
      // If cardStatus already changed while we were waiting, re-enable now
      setActionPending(false);
    }, 600);
  }, []);

  const handlePick = useCallback(async () => {
    if (!selectedCard) return;
    startAction();
    await submitPick(selectedCard);
    clearSelectedCard();
  }, [selectedCard, submitPick, clearSelectedCard, startAction]);

  const handleQueue = useCallback(() => {
    if (!selectedCard) return;
    startAction();
    addToQueue(selectedCard);
  }, [selectedCard, addToQueue, startAction]);

  const handleUnqueue = useCallback(() => {
    if (!selectedCard) return;
    startAction();
    removeFromQueue(selectedCard);
  }, [selectedCard, removeFromQueue, startAction]);

  const handleFloat = useCallback(() => {
    if (!selectedCard) return;
    startAction();
    addFloat(selectedCard);
  }, [selectedCard, addFloat, startAction]);

  const handleUnfloat = useCallback(() => {
    if (!selectedCard) return;
    startAction();
    removeFloat(selectedCard);
  }, [selectedCard, removeFloat, startAction]);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelectedCard();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, clearSelectedCard]);

  if (!isOpen || !selectedCard) return null;

  // Determine which action buttons to show
  const showActions =
    isLiveDraft && cardStatus !== "taken" && cardStatus !== "picked";

  // Whether queue button should be available
  const canQueue = isAuthed && !(isMyTurn && queue.length === 0 && autoPick);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={clearSelectedCard}
    >
      <div
        className="mx-4 max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-zinc-800 shadow-2xl"
        style={{ background: "#1a1917" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex justify-end px-3 pt-3">
          <button
            type="button"
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-white"
            onClick={clearSelectedCard}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="-mt-5 flex flex-col gap-5 p-5 sm:flex-row">
          {/* Left / Top: Card image + actions */}
          <div className="shrink-0 sm:w-[220px]">
            {scryfallImageUrl && (
              <img
                src={scryfallImageUrl}
                alt={selectedCard}
                width={220}
                height={308}
                className="mx-auto w-[180px] rounded-lg sm:w-[220px]"
              />
            )}
            {showActions && (
              <div className="mt-3 flex flex-col gap-2">
                <ActionButtons
                  cardStatus={cardStatus}
                  isMyTurn={isAuthed && isMyTurn}
                  queuePosition={queuePosition}
                  queuedCount={queuedCount}
                  remainingCopies={remainingCopies}
                  disabled={actionPending}
                  onPick={isAuthed ? handlePick : undefined}
                  onQueue={canQueue ? handleQueue : undefined}
                  onUnqueue={isAuthed ? handleUnqueue : undefined}
                  onFloat={isAuthed ? handleFloat : undefined}
                  onUnfloat={isAuthed ? handleUnfloat : undefined}
                />
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

type StatsData = CardStatsData;

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

interface ActionButtonsProps {
  cardStatus?: CardStatus;
  isMyTurn?: boolean;
  queuePosition?: number;
  queuedCount?: number;
  remainingCopies?: number;
  disabled?: boolean;
  onPick?: () => void;
  onQueue?: () => void;
  onUnqueue?: () => void;
  onFloat?: () => void;
  onUnfloat?: () => void;
}

function ActionButtons(props: ActionButtonsProps) {
  const { cardStatus, isMyTurn, disabled } = props;

  const queueBtn = "w-full cursor-pointer rounded-lg bg-amber-700 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed";
  const secondaryBtn = "w-full cursor-pointer rounded-lg bg-zinc-700 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed";

  switch (cardStatus) {
    case "none":
      return (
        <>
          {isMyTurn && props.onPick && <HoldToPickButton onPick={props.onPick} disabled={disabled} />}
          {props.onQueue && (
            <button className={queueBtn} onClick={props.onQueue} disabled={disabled}>
              Queue
            </button>
          )}
          {props.onFloat && (
            <button className={secondaryBtn} onClick={props.onFloat} disabled={disabled}>
              Float
            </button>
          )}
        </>
      );

    case "queued": {
      const canQueueMore = props.onQueue &&
        props.queuedCount != null &&
        props.remainingCopies != null &&
        props.queuedCount < props.remainingCopies;
      const countLabel = props.queuedCount != null && props.remainingCopies != null
        ? ` · ${props.queuedCount}/${props.remainingCopies} queued`
        : "";
      return (
        <>
          {isMyTurn && props.onPick && <HoldToPickButton onPick={props.onPick} disabled={disabled} />}
          {canQueueMore && (
            <button className={queueBtn} onClick={props.onQueue} disabled={disabled}>
              Queue
            </button>
          )}
          {props.onUnqueue && (
            <button className={secondaryBtn} onClick={props.onUnqueue} disabled={disabled}>
              Unqueue{props.queuePosition != null ? ` (#${props.queuePosition})` : ""}{countLabel}
            </button>
          )}
        </>
      );
    }

    case "floated":
      return (
        <>
          {isMyTurn && props.onPick && <HoldToPickButton onPick={props.onPick} disabled={disabled} />}
          {props.onQueue && (
            <button className={queueBtn} onClick={props.onQueue} disabled={disabled}>
              Queue
            </button>
          )}
          {props.onUnfloat && (
            <button className={secondaryBtn} onClick={props.onUnfloat} disabled={disabled}>
              Unfloat
            </button>
          )}
        </>
      );

    default:
      return null;
  }
}
