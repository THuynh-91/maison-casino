"use strict";
/* Standard 52-card deck utilities shared by Blackjack and Poker. */
const { shuffle } = require("./rng");

const SUITS = ["s", "h", "d", "c"]; // spades, hearts, diamonds, clubs
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];

// A card is a 2-char string like "As", "Td", "9c". rank then suit.
function makeDeck(numDecks = 1) {
  const deck = [];
  for (let d = 0; d < numDecks; d++) {
    for (const r of RANKS) {
      for (const s of SUITS) deck.push(r + s);
    }
  }
  return deck;
}

function makeShuffledDeck(numDecks = 1) {
  return shuffle(makeDeck(numDecks));
}

function rankOf(card) {
  return card[0];
}
function suitOf(card) {
  return card[1];
}
// Numeric rank value 2..14 (Ace high). Blackjack handles Ace=1/11 separately.
function rankValue(card) {
  const r = rankOf(card);
  if (r === "A") return 14;
  if (r === "K") return 13;
  if (r === "Q") return 12;
  if (r === "J") return 11;
  if (r === "T") return 10;
  return parseInt(r, 10);
}

module.exports = { SUITS, RANKS, makeDeck, makeShuffledDeck, rankOf, suitOf, rankValue };
