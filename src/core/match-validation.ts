/** Returns error message or null if valid */
export function validateMatchResult(wins: number, losses: number): string | null {
  if (wins < 0 || wins > 2 || losses < 0 || losses > 2) {
    return 'Wins and losses must be between 0 and 2';
  }
  if (wins !== 2 && losses !== 2) {
    return 'At least one side must have 2 wins';
  }
  return null;
}
