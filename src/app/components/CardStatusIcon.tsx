export type CardStatus = "picked" | "queued" | "floated" | "none";

type CardStatusIconProps = {
  status: CardStatus;
  queuePosition?: number;
};

export function CardStatusIcon({ status, queuePosition }: CardStatusIconProps) {
  switch (status) {
    case "picked":
      return (
        <span className="inline-flex items-center justify-center w-5 h-5 text-emerald-500" title="Picked">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
            <circle cx="8" cy="8" r="6" />
            <path d="M5.5 8l2 2 3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      );
    case "queued":
      return (
        <span className="relative inline-flex items-center justify-center w-5 h-5 text-amber-500" title={`Queue position ${queuePosition}`}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-4 h-4">
            <rect x="3" y="5" width="10" height="7" rx="1" />
            <path d="M4.5 5V4a1 1 0 011-1h5a1 1 0 011 1v1" />
          </svg>
          <span className="absolute -top-1 -right-1.5 text-[9px] font-bold text-amber-400">
            {queuePosition}
          </span>
        </span>
      );
    case "floated":
      return (
        <span className="inline-flex items-center justify-center w-5 h-5 text-zinc-500" title="Floated">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="w-4 h-4" strokeDasharray="2 1.5">
            <rect x="3" y="5" width="10" height="7" rx="1" />
            <path d="M4.5 5V4a1 1 0 011-1h5a1 1 0 011 1v1" />
          </svg>
        </span>
      );
    case "none":
      return null;
  }
}
