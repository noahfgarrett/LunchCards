import assert from "node:assert/strict";
import {
  canLaunchSession,
  describeSessionStatus,
  formatSeatLabel,
  getJoinableSessions,
  makeSessionShareUrl
} from "../queue-state.js";

const sessions = [
  { code: "ALPHA", status: "lobby", player_count: 4, game: "hearts", host_name: "Ari", players: [{ is_cpu: false }, { is_cpu: true }] },
  { code: "BRAVO", status: "playing", player_count: 4, game: "spades", host_name: "Bea", players: [{ is_cpu: false }, { is_cpu: false }, { is_cpu: true }] },
  { code: "DONE", status: "complete", player_count: 4, game: "euchre", host_name: "Cam", players: [] }
];

assert.deepEqual(getJoinableSessions(sessions).map(session => session.code), ["ALPHA", "BRAVO"]);
assert.equal(formatSeatLabel({ name: "Noah", is_cpu: false, is_ready: true, is_host: true }, 0), "Seat 1: Noah · Host · Ready");
assert.equal(formatSeatLabel(null, 3), "Seat 4: Open");
assert.equal(describeSessionStatus(sessions[0]), "2/4 seated · Hearts · Lobby");
assert.equal(describeSessionStatus(sessions[1]), "3/4 seated · Spades · In progress");
assert.equal(canLaunchSession({ player_count: 4, players: [{}, {}, {}, {}] }), true);
assert.equal(canLaunchSession({ player_count: 4, players: [{}, {}, {}] }), false);
assert.equal(makeSessionShareUrl("https://noahfgarrett.github.io/TableCards/?x=1", "ALPHA"), "https://noahfgarrett.github.io/TableCards/?x=1&hub=ALPHA");

console.log("queue-state tests passed");
