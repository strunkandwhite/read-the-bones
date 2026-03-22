"use client";

import { useEffect } from "react";

const BANNER = `
    ◇───◇
   / \\ / \\
  ◇   ◇   ◇   A Product of Lenehan-Hu Applied Dynamics
   \\ / \\ /
    ◇───◇

`;

export function ConsoleBanner() {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log(BANNER);
  }, []);

  return null;
}
