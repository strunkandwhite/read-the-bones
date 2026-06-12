"use client";

import { useState, type ReactNode } from "react";

interface CollapsibleSectionProps {
  title: string;
  /** localStorage key persisting the collapsed state across modal open/close. */
  storageKey: string;
  children: ReactNode;
  /** Classes always applied to the section element. */
  className?: string;
  /** Classes applied to the section element only while expanded. */
  expandedClassName?: string;
  /** Classes applied to the body wrapper (hidden while collapsed). */
  bodyClassName?: string;
}

function readStoredCollapsed(storageKey: string): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(storageKey) === "true";
}

/**
 * Collapsible section for the draft board modal. The header button reuses the
 * rotating-chevron styling of the Settings "How it works" section. The body
 * stays mounted while collapsed (hidden via the `hidden` attribute), so
 * children driven by store polling keep receiving live updates.
 *
 * Collapsed state persists to localStorage so it survives modal close/reopen.
 * The modal only mounts after user interaction (never during SSR), so reading
 * localStorage in the lazy initializer is safe.
 */
export function CollapsibleSection({
  title,
  storageKey,
  children,
  className = "",
  expandedClassName = "",
  bodyClassName = "",
}: CollapsibleSectionProps) {
  const [collapsed, setCollapsed] = useState(() => readStoredCollapsed(storageKey));

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(storageKey, String(next));
  };

  return (
    <section className={`${className} ${collapsed ? "" : expandedClassName}`.trim()}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full shrink-0 cursor-pointer items-center justify-between border-none bg-transparent px-0 py-1 text-left text-[13px] font-semibold tracking-tight text-zinc-200 transition-colors hover:text-white"
      >
        {title}
        <svg
          className={`h-4 w-4 text-zinc-500 transition-transform ${collapsed ? "" : "rotate-180"}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <div hidden={collapsed} className={bodyClassName || undefined}>
        {children}
      </div>
    </section>
  );
}
