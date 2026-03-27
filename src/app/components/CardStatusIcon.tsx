export type CardStatus = "picked" | "queued" | "floated" | "none";

type CardStatusIconProps = {
  status: CardStatus;
  queuePosition?: number;
};

export function CardStatusIcon({ status, queuePosition }: CardStatusIconProps) {
  switch (status) {
    case "picked":
      return (
        <span className="inline-flex items-center justify-center w-4 h-4 text-green-500" title="Picked">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
            <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
          </svg>
        </span>
      );
    case "queued":
      return (
        <span
          className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue-600 text-white text-[9px] font-bold"
          title={`Queue position ${queuePosition}`}
        >
          {queuePosition}
        </span>
      );
    case "floated":
      return (
        <span className="inline-flex items-center justify-center w-4 h-4 text-gray-400" title="Floated">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
            <path d="M3 2.5h10l-1.5 5H4.5L3 2.5zM4.5 7.5v5.5M11.5 7.5v5.5" />
          </svg>
        </span>
      );
    case "none":
      return null;
  }
}
