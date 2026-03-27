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
      className={`relative overflow-hidden w-full rounded-lg py-3.5 text-center font-bold text-base text-white
        ${confirmed
          ? "bg-emerald-500"
          : disabled
            ? "bg-gray-600 cursor-not-allowed"
            : "bg-emerald-700 hover:bg-emerald-600 cursor-pointer"}
        transition-colors select-none touch-none`}
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
