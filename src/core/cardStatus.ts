export type CardStatus = "picked" | "queued" | "floated" | "none" | "taken";

export type CardStatusResult = {
  status: CardStatus;
  queuePosition?: number;
};
