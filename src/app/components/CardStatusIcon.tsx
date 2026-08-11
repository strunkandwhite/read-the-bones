import type { CardStatus } from "@/core/cardStatus";
export type { CardStatus } from "@/core/cardStatus";

type CardStatusIconProps = {
  status: CardStatus;
  queuePosition?: number;
};

export function CardStatusIcon({ status, queuePosition }: CardStatusIconProps) {
  switch (status) {
    case "picked":
      return (
        <span
          className="inline-flex h-5 w-5 items-center justify-center text-emerald-500"
          title="Picked"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="h-4 w-4"
          >
            <circle cx="8" cy="8" r="6" />
            <path d="M5.5 8l2 2 3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      );
    case "queued":
      return (
        <span
          className="relative inline-flex h-5 w-5 items-center justify-center text-amber-500"
          title={`Queue position ${queuePosition}`}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" stroke="none" className="h-4 w-4">
            <rect x="3" y="2.5" width="10" height="1.8" rx="0.4" />
            <rect x="3.4" y="5.3" width="10" height="1.8" rx="0.4" />
            <rect x="3.8" y="8.1" width="10" height="1.8" rx="0.4" />
            <rect x="4.2" y="10.9" width="10" height="1.8" rx="0.4" />
          </svg>
          <span className="absolute -top-1 -right-1.5 text-[9px] font-bold text-amber-400">
            {queuePosition}
          </span>
        </span>
      );
    case "floated":
      return (
        <span
          className="inline-flex h-5 w-5 items-center justify-center text-zinc-500"
          title="Floated"
        >
          <svg
            viewBox="0 0 16 16"
            fill="currentColor"
            stroke="none"
            className="h-4 w-4"
            opacity="0.6"
          >
            <rect x="3" y="2.5" width="10" height="1.8" rx="0.4" />
            <rect x="3.4" y="5.3" width="10" height="1.8" rx="0.4" />
            <rect x="3.8" y="8.1" width="10" height="1.8" rx="0.4" />
            <rect x="4.2" y="10.9" width="10" height="1.8" rx="0.4" />
          </svg>
        </span>
      );
    case "none":
      return null;
    case "taken":
      return null;
  }
}
