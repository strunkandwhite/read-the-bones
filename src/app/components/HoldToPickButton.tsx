import { useHoldToConfirm } from "@/app/hooks/useHoldToConfirm";

type HoldToPickButtonProps = {
  onPick: () => void;
  disabled?: boolean;
};

export function HoldToPickButton({ onPick, disabled }: HoldToPickButtonProps) {
  const { isHolding, progress, handlers } = useHoldToConfirm({
    onConfirm: onPick,
    duration: 1500,
  });

  return (
    <button
      className={`relative overflow-hidden w-full rounded-lg py-3.5 text-center font-bold text-base text-white
        ${disabled ? "bg-gray-600 cursor-not-allowed" : "bg-green-700 hover:bg-green-600 cursor-pointer"}
        transition-colors select-none touch-none`}
      disabled={disabled}
      {...(disabled ? {} : handlers)}
      role="button"
      aria-label="Hold to pick this card"
    >
      {/* Progress bar fill */}
      <div
        className="absolute inset-0 bg-green-500 transition-none"
        style={{
          width: `${progress * 100}%`,
          opacity: isHolding ? 0.4 : 0,
        }}
      />
      <span className="relative z-10">
        {isHolding ? "Picking..." : "Hold to Pick"}
      </span>
    </button>
  );
}
