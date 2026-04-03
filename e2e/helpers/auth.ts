import { Page } from "@playwright/test";

export async function authenticateAs(
  page: Page,
  opts: { draftId: string; seat: number; displayName: string },
) {
  await page.addInitScript(
    ({ draftId, token }) => {
      localStorage.setItem(`seatToken:${draftId}`, token);
      localStorage.setItem("activeDraft", draftId);
    },
    { draftId: opts.draftId, token: "test-seat-token" },
  );
}
