import { useHoldToConfirm } from "@/app/hooks/useHoldToConfirm";

type HoldToPickButtonProps = {
  onPick: () => void;
  disabled?: boolean;
};

export function HoldToPickButton({ onPick, disabled }: HoldToPickButtonProps) {
  const { isHolding, progress, confirmed, handlers } = useHoldToConfirm({
    onConfirm: onPick,
    duration: 1500,
  });

  const label = confirmed ? "Picked!" : isHolding ? "Picking..." : "Hold to Pick";

  return (
    <button
      className={`relative w-full overflow-hidden rounded-lg py-3.5 text-center text-base font-bold text-white ${
        confirmed
          ? "bg-emerald-500"
          : disabled
            ? "cursor-not-allowed bg-gray-600"
            : "cursor-pointer bg-emerald-700 hover:bg-emerald-600"
      } touch-none transition-colors select-none`}
      disabled={disabled || confirmed}
      {...(disabled || confirmed ? {} : handlers)}
      role="button"
      aria-label="Hold to pick this card"
    >
      {/* Progress bar fill */}
      <div
        className="absolute inset-0 bg-emerald-500 transition-none"
        style={{
          width: confirmed ? "100%" : `${progress * 100}%`,
          opacity: confirmed ? 0.6 : isHolding ? 0.4 : 0,
        }}
      />
      <span className="relative z-10">{label}</span>
    </button>
  );
}
