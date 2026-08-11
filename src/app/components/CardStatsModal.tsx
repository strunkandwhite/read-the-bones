"use client";

import { useEffect, useMemo, useCallback, useState, useRef } from "react";
import { useCardStore } from "@/app/stores/cardStore";
import { useDraftStore } from "@/app/stores/draftStore";
import { useLiveStore } from "@/app/stores/liveStore";
import { useCardStatus, getImageUrl, useIsAuthed, useLocalDeckMode } from "@/app/stores/selectors";
import { isLocalClient } from "@/core/isLocal";
import { colorPairBg } from "@/core/manaColors";
import type { CardStatsData } from "@/app/stores/cardStore";
import { HoldToPickButton } from "./HoldToPickButton";
import { DistributionHistogram } from "./DistributionHistogram";
import { Sparkline } from "./Sparkline";
import { ColorPills } from "./ManaSymbols";
import type { DraftScore } from "@/core/types";

import type { CardStatus } from "@/core/cardStatus";
import type { WorthCard } from "@/core/worthModel";
import { ciMarginPct } from "@/core/wilsonInterval";
import { WORTH_EXPLANATION, PVI_EXPLANATION, DESIRE_EXPLANATION } from "./CardTable";
import { formatSignedPercent, formatSignedZ } from "./worthFormat";
import { InfoTooltip } from "./InfoTooltip";
import {
  desireAt,
  desireIndex,
  formatDesireIndex,
  maxAbsWorth,
  DEFAULT_TOTAL_PICKS,
} from "./desireCurve";
import { DesireCurveChart } from "./DesireCurveChart";

const GAMES_EXPLANATION = `Games played by decks that maindecked this card, across stats-eligible drafts — the sample behind Worth and PVI.`;

// Minimum duration (ms) to show the disabled state after a queue/pick/float action,
// so the UI change is perceptible even if the server responds instantly.
const ACTION_PENDING_MIN_MS = 600;

export function CardStatsModal() {
  // Card store
  const selectedCard = useCardStore((s) => s.selectedCard);
  const clearSelectedCard = useCardStore((s) => s.clearSelectedCard);
  const data = useCardStore((s) => s.cardStatsDetail);
  const loading = useCardStore((s) => s.cardStatsLoading);
  const worthCard = useCardStore((s) =>
    s.selectedCard ? s.worthCards.get(s.selectedCard) : undefined
  );
  const worthModel = useCardStore((s) => s.worthModel);
  const worthCards = useCardStore((s) => s.worthCards);
  // Desire-index denominator: the cube's largest |worth| (see desireCurve.ts).
  const worthScale = useMemo(() => maxAbsWorth(worthCards.values()), [worthCards]);

  // Draft store
  const activeDraft = useDraftStore((s) => s.activeDraft);
  const board = useDraftStore((s) => s.board);
  const liveDraftStatus = useDraftStore((s) => s.liveDraftStatus);
  const boardPhase = board?.phase;

  // Desire is evaluated at the live draft's current pick while drafting,
  // at pick 1 (draft-start view) otherwise — mirrors the CardTable column,
  // including the dev-only settings override.
  //
  // board.picks.length undercounts once ingest-time redaction is live
  // (opted-out seats' picks are never stored, leaving gaps in pick_n).
  // latestPickN (MAX(pick_n), robust to gaps) is the correct source;
  // board.picks.length is only a fallback for the moment board is
  // populated before liveDraftStatus (both come from the same /live
  // response, so in practice they never diverge).
  const desirePickOverride = useCardStore((s) => s.desirePickOverride);
  const isDrafting = boardPhase === "drafting" && Array.isArray(board?.picks);
  const currentPick =
    desirePickOverride ??
    (isDrafting ? (liveDraftStatus?.latestPickN ?? board!.picks.length) + 1 : 1);
  const totalPicks = board ? board.numSeats * board.picksPerPlayer : DEFAULT_TOTAL_PICKS;

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
  const localDeckMode = useLocalDeckMode();
  const isOpen = !!selectedCard;
  const isLocal = useMemo(() => isLocalClient(), []);
  const isLiveDraft = !!activeDraft && boardPhase === "drafting";

  const scryfallImageUrl = useMemo(() => getImageUrl(selectedCard), [selectedCard]);

  // useCardStatus subscribes to all actual inputs of getCardStatus (queue, float, taken,
  // seat, cardData) so this result updates reactively without a hand-mirrored dep list.
  const cardStatusResult = useCardStatus(selectedCard ?? null);

  const cardStatus: CardStatus = cardStatusResult.status;
  const queuePosition = cardStatusResult.queuePosition;
  const queuedCount = cardStatusResult.queuedCount;
  const remainingCopies = cardStatusResult.remainingCopies;

  // Disable buttons briefly after any action to prevent double-clicks.
  // Re-enables after the server confirms (cardStatus changes) or 600ms, whichever is later.
  const [actionPending, setActionPending] = useState(false);
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minimumElapsedRef = useRef(false);

  // When cardStatus changes AND minimum time has elapsed, re-enable.
  useEffect(() => {
    if (actionPending && minimumElapsedRef.current) {
      setActionPending(false);
      minimumElapsedRef.current = false;
    }
  }, [cardStatus, queuePosition]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setActionPending(false); // eslint-disable-line react-hooks/set-state-in-effect -- resetting UI state when selected card changes
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
    }, ACTION_PENDING_MIN_MS);
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
  // For multi-copy cards the player already owns, allow actions if copies remain
  const pickedButCopiesRemain = cardStatus === "picked" && (remainingCopies ?? 0) > 0;
  const showActions =
    (isLiveDraft || localDeckMode) &&
    cardStatus !== "taken" &&
    (cardStatus !== "picked" || pickedButCopiesRemain);

  // Whether queue button should be available
  const canQueue = isAuthed && !(isMyTurn && queue.length === 0 && autoPick);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={clearSelectedCard}
    >
      <div
        className="mx-4 max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-xl border border-zinc-800 shadow-2xl"
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
                  localDeckMode={localDeckMode}
                  onPick={isAuthed ? handlePick : undefined}
                  onQueue={canQueue ? handleQueue : undefined}
                  onUnqueue={isAuthed ? handleUnqueue : undefined}
                  onFloat={isAuthed || localDeckMode ? handleFloat : undefined}
                  onUnfloat={isAuthed || localDeckMode ? handleUnfloat : undefined}
                />
              </div>
            )}
          </div>

          {/* Right / Bottom: Stats */}
          <div className="min-w-0 flex-1">
            {loading ? (
              <div className="text-sm text-gray-500">Loading stats...</div>
            ) : data ? (
              <StatsContent
                data={data}
                isLocal={isLocal}
                worthCard={worthCard}
                worthModel={worthModel}
                worthScale={worthScale}
                currentPick={currentPick}
                totalPicks={totalPicks}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Helpers ---

/** Aggregate same-date drafts into a single sparkline point using geometric mean */
function aggregateByDate(history: StatsData["pick_history"]): DraftScore[] {
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
      const avgSeats = Math.round(entries.reduce((sum, h) => sum + h.numSeats, 0) / entries.length);
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

function StatsContent({
  data,
  isLocal,
  worthCard,
  worthModel,
  worthScale,
  currentPick,
  totalPicks,
}: {
  data: StatsData;
  isLocal?: boolean;
  worthCard?: WorthCard;
  worthModel?: { sigma: number } | null;
  worthScale: number;
  currentPick: number;
  totalPicks: number;
}) {
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
            annotation={`\u00b1${ciMarginPct(wins.win_rate_ci)}%`}
          />
        )}
      </div>

      {/* Worth model (dev-only) */}
      {isLocal && worthCard && (
        <div>
          <div className="mb-1.5 text-xs font-medium text-zinc-400">Worth Model</div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <StatRow
              label="Worth"
              value={worthCard.worth != null ? formatSignedPercent(worthCard.worth) : "—"}
              annotation={worthCard.prior_only ? "prior only" : undefined}
              tooltip={WORTH_EXPLANATION}
            />
            <StatRow
              label="PVI"
              value={worthCard.pvi != null ? formatSignedZ(worthCard.pvi) : "—"}
              tooltip={PVI_EXPLANATION}
              tooltipAlign="right"
            />
            <StatRow label="Games" value={String(worthCard.games)} tooltip={GAMES_EXPLANATION} />
            {worthModel &&
              worthModel.sigma > 0 &&
              worthScale > 0 &&
              worthCard.worth != null &&
              worthCard.geomean != null && (
                <StatRow
                  label="Desire"
                  value={formatDesireIndex(
                    desireIndex(
                      desireAt(currentPick, {
                        worth: worthCard.worth,
                        geomean: worthCard.geomean,
                        sigma: worthModel.sigma,
                      }),
                      worthScale
                    )!
                  )}
                  annotation={`at pick ${currentPick}`}
                  tooltip={DESIRE_EXPLANATION}
                />
              )}
          </div>
          {worthModel &&
            worthModel.sigma > 0 &&
            worthScale > 0 &&
            worthCard.worth != null &&
            worthCard.geomean != null && (
              <div className="mt-3">
                <div className="mb-1.5 text-xs font-medium text-zinc-400">Desire by Pick</div>
                <DesireCurveChart
                  inputs={{
                    worth: worthCard.worth,
                    geomean: worthCard.geomean,
                    sigma: worthModel.sigma,
                  }}
                  worthScale={worthScale}
                  totalPicks={totalPicks}
                  currentPick={currentPick}
                />
              </div>
            )}
        </div>
      )}

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

function StatRow({
  label,
  value,
  annotation,
  tooltip,
  tooltipAlign,
}: {
  label: string;
  value: string;
  annotation?: string;
  tooltip?: string;
  tooltipAlign?: "left" | "right";
}) {
  return (
    <div>
      <div className="inline-flex items-center text-xs text-zinc-400">
        {label}
        {tooltip && <InfoTooltip text={tooltip} align={tooltipAlign} />}
      </div>
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

// Queueing a card clears its float, and unqueueing restores it (see
// addToQueue / removeFromQueue in stores/live/queueFloat.ts), which is why the
// unqueue copy promises the card stays in your floats.
const QUEUE_TOOLTIP = "Auto-pick takes this on your turn, in queue order. Private to you.";
const UNQUEUE_TOOLTIP = "Take this off your queue. It stays in your floats.";
const FLOAT_TOOLTIP =
  "Private shortlist; won't be picked for you, but shows up in your deck builder.";
const UNFLOAT_TOOLTIP = "Drop this from your shortlist.";
const ADD_TO_DECK_BUILDER_TOOLTIP =
  "Track this in your deck builder as a card you're hoping to get.";
const REMOVE_FROM_DECK_BUILDER_TOOLTIP = "Stop tracking this card.";

interface ActionButtonsProps {
  cardStatus?: CardStatus;
  isMyTurn?: boolean;
  queuePosition?: number;
  queuedCount?: number;
  remainingCopies?: number;
  disabled?: boolean;
  localDeckMode?: boolean;
  onPick?: () => void;
  onQueue?: () => void;
  onUnqueue?: () => void;
  onFloat?: () => void;
  onUnfloat?: () => void;
}

function ActionButtons(props: ActionButtonsProps) {
  const { cardStatus, isMyTurn, disabled } = props;

  const queueBtn =
    "w-full cursor-pointer rounded-lg bg-amber-700 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed";
  const secondaryBtn =
    "w-full cursor-pointer rounded-lg bg-zinc-700 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed";

  const floatLabel = props.localDeckMode ? "Add to Deck Builder" : "Float";
  const unfloatLabel = props.localDeckMode ? "Remove from Deck Builder" : "Unfloat";
  const floatTooltip = props.localDeckMode ? ADD_TO_DECK_BUILDER_TOOLTIP : FLOAT_TOOLTIP;
  const unfloatTooltip = props.localDeckMode ? REMOVE_FROM_DECK_BUILDER_TOOLTIP : UNFLOAT_TOOLTIP;

  switch (cardStatus) {
    case "none":
      return (
        <>
          {isMyTurn && props.onPick && (
            <HoldToPickButton onPick={props.onPick} disabled={disabled} />
          )}
          {props.onQueue && (
            <button
              className={queueBtn}
              onClick={props.onQueue}
              disabled={disabled}
              title={QUEUE_TOOLTIP}
            >
              Queue
            </button>
          )}
          {props.onFloat && (
            <button
              className={secondaryBtn}
              onClick={props.onFloat}
              disabled={disabled}
              title={floatTooltip}
            >
              {floatLabel}
            </button>
          )}
        </>
      );

    case "queued": {
      const canQueueMore =
        props.onQueue &&
        props.queuedCount != null &&
        props.remainingCopies != null &&
        props.queuedCount < props.remainingCopies;
      const countLabel =
        props.queuedCount != null && props.remainingCopies != null
          ? ` · ${props.queuedCount}/${props.remainingCopies} queued`
          : "";
      return (
        <>
          {isMyTurn && props.onPick && (
            <HoldToPickButton onPick={props.onPick} disabled={disabled} />
          )}
          {canQueueMore && (
            <button
              className={queueBtn}
              onClick={props.onQueue}
              disabled={disabled}
              title={QUEUE_TOOLTIP}
            >
              Queue
            </button>
          )}
          {props.onUnqueue && (
            <button
              className={secondaryBtn}
              onClick={props.onUnqueue}
              disabled={disabled}
              title={UNQUEUE_TOOLTIP}
            >
              Unqueue{props.queuePosition != null ? ` (#${props.queuePosition})` : ""}
              {countLabel}
            </button>
          )}
        </>
      );
    }

    case "floated":
      return (
        <>
          {isMyTurn && props.onPick && (
            <HoldToPickButton onPick={props.onPick} disabled={disabled} />
          )}
          {props.onQueue && (
            <button
              className={queueBtn}
              onClick={props.onQueue}
              disabled={disabled}
              title={QUEUE_TOOLTIP}
            >
              Queue
            </button>
          )}
          {props.onUnfloat && (
            <button
              className={secondaryBtn}
              onClick={props.onUnfloat}
              disabled={disabled}
              title={unfloatTooltip}
            >
              {unfloatLabel}
            </button>
          )}
        </>
      );

    case "picked":
      // Multi-copy card — you have one but copies remain; allow pick/queue/float for additional copies
      if ((props.remainingCopies ?? 0) > 0) {
        return (
          <>
            {isMyTurn && props.onPick && (
              <HoldToPickButton onPick={props.onPick} disabled={disabled} />
            )}
            {props.onQueue && (
              <button
                className={queueBtn}
                onClick={props.onQueue}
                disabled={disabled}
                title={QUEUE_TOOLTIP}
              >
                Queue
              </button>
            )}
            {props.onFloat && (
              <button
                className={secondaryBtn}
                onClick={props.onFloat}
                disabled={disabled}
                title={floatTooltip}
              >
                {floatLabel}
              </button>
            )}
          </>
        );
      }
      return null;

    default:
      return null;
  }
}
