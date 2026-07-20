import { Hand } from "./poker-solver.js";

const SUIT_CODE = { clubs: "c", diamonds: "d", hearts: "h", spades: "s" };

export function pokerCardCode(card) {
  const rank = card.rank === "10" ? "T" : card.rank;
  return `${rank}${SUIT_CODE[card.suit]}`;
}

export function solvePokerHand(cards) {
  return Hand.solve(cards.map(pokerCardCode));
}

export function determinePokerWinners(entries, community) {
  const solved = entries.map(entry => ({
    ...entry,
    solved: solvePokerHand([...entry.cards, ...community])
  }));
  const winners = new Set(Hand.winners(solved.map(entry => entry.solved)));
  return {
    entries: solved,
    winners: solved.filter(entry => winners.has(entry.solved)),
    description: solved.find(entry => winners.has(entry.solved))?.solved.descr || "High Card"
  };
}
