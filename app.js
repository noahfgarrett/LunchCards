import {
  canLaunchSession,
  describeSessionStatus,
  formatSeatLabel,
  getJoinableSessions,
  makeSessionShareUrl
} from "./queue-state.js";

const SUITS = ["hearts", "spades", "diamonds", "clubs"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUIT_SYMBOLS = { hearts: "♥", spades: "♠", diamonds: "♦", clubs: "♣" };
const RED_SUITS = new Set(["hearts", "diamonds"]);
const DIFFICULTY = {
  easy: { label: "Easy", risk: 0.26, memory: 0.35 },
  normal: { label: "Normal", risk: 0.48, memory: 0.6 },
  hard: { label: "Hard", risk: 0.68, memory: 0.82 },
  expert: { label: "Expert", risk: 0.86, memory: 0.95 }
};
const GAMES = {
  hearts: {
    title: "Hearts",
    range: "3-8 players",
    summary: "Pass three, dodge points, and keep the Queen of Spades out of your pile.",
    min: 3,
    max: 8,
    defaultPlayers: 4,
    target: 100
  },
  spades: {
    title: "Spades",
    range: "3-8 players",
    summary: "Bid your tricks, manage trump, and track bags across each round.",
    min: 3,
    max: 8,
    defaultPlayers: 4,
    target: 250
  },
  euchre: {
    title: "Euchre",
    range: "4 players",
    summary: "Call trump, lean on bowers, and take three tricks with your partner.",
    min: 4,
    max: 4,
    defaultPlayers: 4,
    target: 10
  }
};
const SEAT_POSITIONS = [
  ["pos-bottom"],
  ["pos-bottom", "pos-top"],
  ["pos-bottom", "pos-right", "pos-left"],
  ["pos-bottom", "pos-right", "pos-top", "pos-left"],
  ["pos-bottom", "pos-bottom-right", "pos-top-right", "pos-top", "pos-left"],
  ["pos-bottom", "pos-bottom-right", "pos-top-right", "pos-top", "pos-top-left", "pos-left"],
  ["pos-bottom", "pos-bottom-right", "pos-right", "pos-top-right", "pos-top", "pos-top-left", "pos-left"],
  ["pos-bottom", "pos-bottom-right", "pos-right", "pos-top-right", "pos-top", "pos-top-left", "pos-left", "pos-bottom-left"]
];

const app = document.querySelector("#app");
const state = {
  screen: "setup",
  config: {
    game: "hearts",
    playerName: "Noah",
    players: 4,
    difficulty: "normal",
    difficulties: {
      hearts: "normal",
      spades: "normal",
      euchre: "normal"
    },
    target: 100
  },
  lobby: null,
  sessions: [],
  clientId: getClientId(),
  queueLoading: false,
  game: null,
  selectedPass: new Set(),
  selectedCard: null,
  pendingReceived: [],
  toast: ""
};
let cpuTimer = null;
let supabaseClientPromise = null;
let queueTimer = null;

function getClientId() {
  const key = "table-cards-client-id";
  const storage = globalThis.localStorage;
  const existing = storage?.getItem(key);
  if (existing) return existing;
  const next = globalThis.crypto?.randomUUID ? crypto.randomUUID() : uid("client");
  storage?.setItem(key, next);
  return next;
}

function saveDisplayName(name) {
  const next = name.trim() || "Player";
  globalThis.localStorage?.setItem("table-cards-display-name", next);
  state.config.playerName = next;
  return next;
}

function loadDisplayName() {
  return globalThis.localStorage?.getItem("table-cards-display-name") || state.config.playerName || "Player";
}

function uid(prefix = "id") {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cardId(card) {
  return `${card.rank}-${card.suit}`;
}

function makeCard(suit, rank) {
  return {
    id: `${rank}-${suit}`,
    suit,
    rank,
    rankValue: RANKS.indexOf(rank) + 2
  };
}

function buildDeck(options = {}) {
  const ranks = options.euchre ? ["9", "10", "J", "Q", "K", "A"] : RANKS;
  return SUITS.flatMap(suit => ranks.map(rank => makeCard(suit, rank)));
}

function trimDeckForPlayers(deck, playerCount) {
  const removeCount = deck.length % playerCount;
  if (!removeCount) return deck.slice();
  const safeOrder = [
    "2-clubs", "2-diamonds", "3-clubs", "3-diamonds", "2-spades",
    "4-clubs", "4-diamonds", "3-spades", "5-clubs", "5-diamonds"
  ];
  const remove = new Set(safeOrder.slice(0, removeCount));
  return deck.filter(card => !remove.has(card.id));
}

function shuffle(cards) {
  const deck = cards.slice();
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [deck[index], deck[swap]] = [deck[swap], deck[index]];
  }
  return deck;
}

function sortHand(hand) {
  return hand.slice().sort((a, b) => {
    const suitDiff = SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
    return suitDiff || a.rankValue - b.rankValue;
  });
}

function deal(deck, players, handSize) {
  players.forEach(player => {
    player.hand = [];
    player.taken = [];
    player.tricks = 0;
    player.roundPoints = 0;
  });
  const count = handSize || Math.floor(deck.length / players.length);
  for (let turn = 0; turn < count; turn += 1) {
    players.forEach(player => {
      const card = deck.shift();
      if (card) player.hand.push(card);
    });
  }
  players.forEach(player => {
    player.hand = sortHand(player.hand);
  });
  return deck;
}

function nextPlayer(game, from = game.current) {
  return (from + 1) % game.players.length;
}

function previousPlayer(game, from = game.current) {
  return (from - 1 + game.players.length) % game.players.length;
}

function makePlayers(count, name, difficulty, gameType) {
  return Array.from({ length: count }, (_, index) => ({
    id: uid("player"),
    name: index === 0 ? name || "You" : `CPU ${index}`,
    human: index === 0,
    cpu: index !== 0,
    difficulty,
    total: 0,
    hand: [],
    taken: [],
    tricks: 0,
    bid: null,
    team: gameType === "euchre" ? index % 2 : count % 2 === 0 && gameType === "spades" ? index % 2 : index
  }));
}

function readSetupConfig() {
  const game = state.config.game;
  const meta = GAMES[game];
  const playerName = saveDisplayName(document.querySelector("#playerName")?.value || loadDisplayName());
  const requested = Number(document.querySelector("#playerCount")?.value || meta.defaultPlayers);
  const players = game === "euchre" ? 4 : clamp(requested, meta.min, meta.max);
  const difficulty = document.querySelector("#difficulty")?.value || state.config.difficulties?.[game] || state.config.difficulty;
  const targetValue = Number(document.querySelector("#targetScore")?.value || meta.target);
  const target = Number.isFinite(targetValue) ? targetValue : meta.target;
  state.config.difficulties = { ...state.config.difficulties, [game]: difficulty };
  return { game, players, difficulty, target, playerName };
}

async function createLobby() {
  const setup = readSetupConfig();
  const lobby = {
    id: uid("lobby"),
    code: createSessionCode(),
    createdAt: new Date().toISOString(),
    config: setup,
    seats: []
  };
  lobby.seats = [{
    id: uid("player"),
    name: lobby.config.playerName,
    human: true,
    cpu: false,
    difficulty: lobby.config.difficulty,
    total: 0,
    hand: [],
    taken: [],
    tricks: 0,
    bid: null,
    team: 0,
    seat_index: 0,
    is_host: true,
    is_ready: true,
    client_id: state.clientId
  }];
  state.config = { ...state.config, ...lobby.config };
  state.lobby = lobby;
  state.screen = "lobby";
  updateUrlLobby(lobby.code);
  render();
  const synced = await syncLobbyToSupabase(lobby);
  if (synced) await refreshLobby(lobby.code);
  await refreshSessions();
  toast("Session ready");
}

function createSoloGame() {
  const setup = readSetupConfig();
  const seats = makePlayers(setup.players, setup.playerName, setup.difficulty, setup.game).map((player, index) => ({
    ...player,
    seat_index: index,
    is_host: index === 0,
    is_ready: true,
    client_id: index === 0 ? state.clientId : `solo-cpu-${setup.game}-${index}`
  }));
  state.config = { ...state.config, ...setup };
  state.lobby = {
    id: uid("solo"),
    code: "SOLO",
    status: "playing",
    createdAt: new Date().toISOString(),
    config: setup,
    seats
  };
  state.game = null;
  history.replaceState({}, "", new URL(window.location.pathname, window.location.origin).href);
  createGameFromLobby();
  toast(`${GAMES[setup.game].title} solo table ready`);
}

function createSessionCode() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function updateUrlLobby(code) {
  const url = new URL(window.location.href);
  url.searchParams.set("hub", code);
  history.replaceState({}, "", url);
}

function createGameFromLobby() {
  const { config, seats } = state.lobby;
  if (state.lobby.status !== "playing") void markLobbyPlaying(state.lobby);
  const orderedSeats = seats.slice().sort((a, b) => a.seat_index - b.seat_index);
  const humanIndex = Math.max(0, orderedSeats.findIndex(seat => seat.client_id === state.clientId && !seat.cpu));
  const rotatedSeats = orderedSeats.slice(humanIndex).concat(orderedSeats.slice(0, humanIndex));
  const players = rotatedSeats.map((player, index) => ({
    ...player,
    human: index === 0 && !player.cpu,
    cpu: index !== 0 || player.cpu,
    hand: [],
    taken: [],
    tricks: 0,
    bid: null,
    roundPoints: 0
  }));
  const base = {
    id: uid("game"),
    type: config.game,
    target: config.target,
    players,
    dealer: players.length - 1,
    leader: 0,
    current: 0,
    trick: [],
    trickNumber: 1,
    round: 0,
    log: [],
    phase: "setup",
    message: "",
    heartsBroken: false,
    spadesBroken: false,
    passDirection: "left",
    receivedByHuman: [],
    trump: null,
    upcard: null,
    biddingRound: 1,
    currentBidder: 0,
    caller: null
  };
  state.game = base;
  state.screen = "table";
  startRound();
}

function logLine(text) {
  state.game.log.unshift(text);
  state.game.log = state.game.log.slice(0, 24);
}

function startRound() {
  const game = state.game;
  state.selectedPass.clear();
  state.selectedCard = null;
  state.pendingReceived = [];
  game.round += 1;
  game.trick = [];
  game.trickNumber = 1;
  game.heartsBroken = false;
  game.spadesBroken = false;
  game.players.forEach(player => {
    player.taken = [];
    player.tricks = 0;
    player.roundPoints = 0;
    player.bid = null;
  });

  if (game.type === "hearts") {
    const deck = shuffle(trimDeckForPlayers(buildDeck(), game.players.length));
    deal(deck, game.players);
    game.passDirection = heartsPassDirection(game.round, game.players.length);
    if (game.passDirection === "hold") {
      startHeartsPlay();
    } else {
      game.phase = "passing";
      game.message = `Choose 3 to ${game.passDirection}`;
      logLine(`Round ${game.round}: pass ${game.passDirection}.`);
    }
  }

  if (game.type === "spades") {
    game.dealer = nextPlayer(game, game.dealer);
    const deck = shuffle(trimDeckForPlayers(buildDeck(), game.players.length));
    deal(deck, game.players);
    game.phase = "bidding";
    game.current = nextPlayer(game, game.dealer);
    game.message = "Set your bid";
    logLine(`Round ${game.round}: ${game.players[game.dealer].name} deals.`);
  }

  if (game.type === "euchre") {
    game.dealer = nextPlayer(game, game.dealer);
    const deck = shuffle(buildDeck({ euchre: true }));
    deal(deck, game.players, 5);
    game.upcard = deck.shift();
    game.trump = null;
    game.caller = null;
    game.phase = "trump";
    game.biddingRound = 1;
    game.currentBidder = nextPlayer(game, game.dealer);
    game.current = game.currentBidder;
    game.message = `${game.upcard.suit} is up`;
    logLine(`Round ${game.round}: ${game.players[game.dealer].name} deals ${game.upcard.rank}${SUIT_SYMBOLS[game.upcard.suit]}.`);
  }
  render();
}

function heartsPassDirection(round, count) {
  const cycle = count % 2 === 0 ? ["left", "right", "across", "hold"] : ["left", "right", "hold"];
  return cycle[(round - 1) % cycle.length];
}

function passTarget(index, direction, count) {
  if (direction === "left") return (index + 1) % count;
  if (direction === "right") return (index - 1 + count) % count;
  if (direction === "across") return (index + Math.floor(count / 2)) % count;
  return index;
}

function chooseHeartsPass(player, difficulty = DIFFICULTY.normal) {
  const risky = player.hand.slice().sort((a, b) => heartsRisk(b, difficulty) - heartsRisk(a, difficulty));
  return risky.slice(0, 3).map(card => card.id);
}

function heartsRisk(card, difficulty) {
  let value = card.rankValue;
  if (card.suit === "hearts") value += 6;
  if (card.suit === "spades" && card.rank === "Q") value += 24;
  if (card.suit === "spades" && ["K", "A"].includes(card.rank)) value += 8;
  return value + difficulty.risk * 3;
}

function confirmHeartsPass() {
  const game = state.game;
  if (state.selectedPass.size !== 3) {
    toast("Pick exactly 3 cards");
    return;
  }
  const passes = game.players.map(player => {
    const ids = player.human ? Array.from(state.selectedPass) : chooseHeartsPass(player, DIFFICULTY[player.difficulty]);
    const cards = ids.map(id => removeCard(player, id)).filter(Boolean);
    return { from: player, cards, target: passTarget(game.players.indexOf(player), game.passDirection, game.players.length) };
  });
  passes.forEach(pass => {
    game.players[pass.target].hand.push(...pass.cards);
    if (game.players[pass.target].human) state.pendingReceived = pass.cards;
  });
  game.players.forEach(player => {
    player.hand = sortHand(player.hand);
  });
  game.phase = "received";
  game.message = "Review the cards you received";
  state.selectedPass.clear();
  logLine("Passing is complete.");
  render();
}

function startHeartsPlay() {
  const game = state.game;
  game.phase = "playing";
  const opener = game.players.findIndex(player => player.hand.some(card => card.id === "2-clubs"));
  game.current = opener >= 0 ? opener : lowestClubHolder(game);
  game.leader = game.current;
  game.message = `${game.players[game.current].name} leads`;
  state.pendingReceived = [];
  render();
}

function lowestClubHolder(game) {
  let best = { index: 0, value: Infinity };
  game.players.forEach((player, index) => {
    player.hand.filter(card => card.suit === "clubs").forEach(card => {
      if (card.rankValue < best.value) best = { index, value: card.rankValue };
    });
  });
  return best.index;
}

function removeCard(player, id) {
  const index = player.hand.findIndex(card => card.id === id);
  if (index < 0) return null;
  return player.hand.splice(index, 1)[0];
}

function validCards(player) {
  const game = state.game;
  if (game.phase !== "playing") return [];
  if (game.type === "hearts") return validHeartsCards(game, player);
  if (game.type === "spades") return validSpadesCards(game, player);
  if (game.type === "euchre") return validEuchreCards(game, player);
  return player.hand;
}

function validHeartsCards(game, player) {
  if (!game.trick.length) {
    if (game.trickNumber === 1) {
      const twoClubs = player.hand.find(card => card.id === "2-clubs");
      if (twoClubs) return [twoClubs];
    }
    const nonHearts = player.hand.filter(card => card.suit !== "hearts");
    return game.heartsBroken || nonHearts.length === 0 ? player.hand : nonHearts;
  }
  const leadSuit = game.trick[0].card.suit;
  const follow = player.hand.filter(card => card.suit === leadSuit);
  if (follow.length) return follow;
  if (game.trickNumber === 1) {
    const safe = player.hand.filter(card => card.suit !== "hearts" && card.id !== "Q-spades");
    return safe.length ? safe : player.hand;
  }
  return player.hand;
}

function validSpadesCards(game, player) {
  if (!game.trick.length) {
    const nonSpades = player.hand.filter(card => card.suit !== "spades");
    return game.spadesBroken || nonSpades.length === 0 ? player.hand : nonSpades;
  }
  const leadSuit = game.trick[0].card.suit;
  const follow = player.hand.filter(card => card.suit === leadSuit);
  return follow.length ? follow : player.hand;
}

function sameEuchreSuit(card, suit, trump) {
  return effectiveSuit(card, trump) === suit;
}

function validEuchreCards(game, player) {
  if (!game.trick.length) return player.hand;
  const leadSuit = effectiveSuit(game.trick[0].card, game.trump);
  const follow = player.hand.filter(card => sameEuchreSuit(card, leadSuit, game.trump));
  return follow.length ? follow : player.hand;
}

function playCard(cardIdValue) {
  const game = state.game;
  const player = game.players[game.current];
  const legal = validCards(player).some(card => card.id === cardIdValue);
  if (!legal || !player.human) {
    toast("That card is not live");
    return;
  }
  commitPlay(player, cardIdValue);
}

function commitPlay(player, cardIdValue) {
  const game = state.game;
  const card = removeCard(player, cardIdValue);
  if (!card) return;
  if (card.suit === "hearts") game.heartsBroken = true;
  if (card.suit === "spades") game.spadesBroken = true;
  game.trick.push({ player: game.current, card });
  logLine(`${player.name} plays ${card.rank}${SUIT_SYMBOLS[card.suit]}.`);
  if (game.trick.length === game.players.length) {
    resolveTrick();
  } else {
    game.current = nextPlayer(game);
    game.message = `${game.players[game.current].name}'s turn`;
  }
  render();
}

function resolveTrick() {
  const game = state.game;
  const winner = trickWinner(game);
  const winnerPlayer = game.players[winner];
  winnerPlayer.taken.push(...game.trick.map(play => play.card));
  winnerPlayer.tricks += 1;
  const points = trickPoints(game);
  winnerPlayer.roundPoints += points;
  game.trick = [];
  game.current = winner;
  game.leader = winner;
  logLine(`${winnerPlayer.name} takes trick ${game.trickNumber}${points ? ` for ${points}` : ""}.`);
  game.trickNumber += 1;
  if (game.players.every(player => player.hand.length === 0)) {
    endRound();
  } else {
    game.message = `${winnerPlayer.name} leads`;
  }
}

function trickWinner(game) {
  if (game.type === "hearts") {
    const leadSuit = game.trick[0].card.suit;
    return game.trick.filter(play => play.card.suit === leadSuit).sort((a, b) => b.card.rankValue - a.card.rankValue)[0].player;
  }
  if (game.type === "spades") {
    const spades = game.trick.filter(play => play.card.suit === "spades");
    if (spades.length) return spades.sort((a, b) => b.card.rankValue - a.card.rankValue)[0].player;
    const leadSuit = game.trick[0].card.suit;
    return game.trick.filter(play => play.card.suit === leadSuit).sort((a, b) => b.card.rankValue - a.card.rankValue)[0].player;
  }
  return euchreTrickWinner(game);
}

function euchreTrickWinner(game) {
  const trumpCards = game.trick.filter(play => effectiveSuit(play.card, game.trump) === game.trump);
  if (trumpCards.length) {
    return trumpCards.sort((a, b) => euchrePower(b.card, game.trump) - euchrePower(a.card, game.trump))[0].player;
  }
  const leadSuit = effectiveSuit(game.trick[0].card, game.trump);
  return game.trick
    .filter(play => effectiveSuit(play.card, game.trump) === leadSuit)
    .sort((a, b) => euchrePower(b.card, game.trump) - euchrePower(a.card, game.trump))[0].player;
}

function trickPoints(game) {
  if (game.type !== "hearts") return 0;
  return game.trick.reduce((sum, play) => sum + (play.card.suit === "hearts" ? 1 : 0) + (play.card.id === "Q-spades" ? 13 : 0), 0);
}

function endRound() {
  const game = state.game;
  if (game.type === "hearts") scoreHeartsRound(game);
  if (game.type === "spades") scoreSpadesRound(game);
  if (game.type === "euchre") scoreEuchreRound(game);
  game.phase = game.players.some(player => player.total >= game.target) ? "gameover" : "roundover";
  game.message = game.phase === "gameover" ? "Match complete" : "Round complete";
}

function scoreHeartsRound(game) {
  const shooter = game.players.find(player => player.roundPoints === 26);
  if (shooter) {
    game.players.forEach(player => {
      if (player !== shooter) player.total += 26;
    });
    logLine(`${shooter.name} shoots the moon.`);
    return;
  }
  game.players.forEach(player => {
    player.total += player.roundPoints;
  });
}

function scoreSpadesRound(game) {
  const teamCount = new Set(game.players.map(player => player.team)).size;
  if (teamCount < game.players.length) {
    Array.from({ length: teamCount }, (_, team) => {
      const teamPlayers = game.players.filter(player => player.team === team);
      const bid = teamPlayers.reduce((sum, player) => sum + Number(player.bid || 0), 0);
      const tricks = teamPlayers.reduce((sum, player) => sum + player.tricks, 0);
      const delta = tricks >= bid ? bid * 10 + (tricks - bid) : bid * -10;
      teamPlayers.forEach(player => {
        player.total += delta;
      });
      logLine(`Team ${team + 1} ${tricks >= bid ? "makes" : "misses"} ${bid}.`);
    });
    return;
  }
  game.players.forEach(player => {
    const bid = Number(player.bid || 0);
    if (player.tricks >= bid) {
      player.total += bid * 10 + (player.tricks - bid);
    } else {
      player.total -= bid * 10;
    }
  });
}

function scoreEuchreRound(game) {
  const callerTeam = game.players[game.caller].team;
  const callerTricks = game.players.filter(player => player.team === callerTeam).reduce((sum, player) => sum + player.tricks, 0);
  let points = 0;
  let team = callerTeam;
  if (callerTricks >= 5) points = 2;
  else if (callerTricks >= 3) points = 1;
  else {
    points = 2;
    team = callerTeam === 0 ? 1 : 0;
  }
  game.players.filter(player => player.team === team).forEach(player => {
    player.total += points;
  });
  logLine(`Team ${team + 1} scores ${points}.`);
}

function chooseCpuCard(player) {
  const game = state.game;
  const legal = validCards(player);
  if (!legal.length) return null;
  if (game.type === "hearts") {
    const sorted = legal.slice().sort((a, b) => heartsRisk(a, DIFFICULTY[player.difficulty]) - heartsRisk(b, DIFFICULTY[player.difficulty]));
    if (!game.trick.length) return sorted[0];
    return sorted[sorted.length - 1];
  }
  if (game.type === "spades") {
    return chooseSpadesCpuCard(game, legal, player);
  }
  return chooseEuchreCpuCard(game, legal);
}

function chooseSpadesCpuCard(game, legal, player) {
  const needsTrick = player.tricks < Number(player.bid || 0);
  const ranked = legal.slice().sort((a, b) => a.rankValue - b.rankValue);
  if (!game.trick.length) return needsTrick ? ranked[ranked.length - 1] : ranked[0];
  return needsTrick ? ranked[ranked.length - 1] : ranked[0];
}

function chooseEuchreCpuCard(game, legal) {
  return legal.slice().sort((a, b) => euchrePower(a, game.trump) - euchrePower(b, game.trump))[0];
}

function submitBid() {
  const game = state.game;
  const human = game.players[0];
  human.bid = clamp(Number(document.querySelector("#bidInput")?.value || 1), 0, human.hand.length);
  game.players.forEach(player => {
    if (player.cpu) player.bid = cpuBid(player);
  });
  game.phase = "playing";
  game.current = nextPlayer(game, game.dealer);
  game.leader = game.current;
  game.message = `${game.players[game.current].name} leads`;
  logLine(`Bids are in: ${game.players.map(player => `${player.name} ${player.bid}`).join(", ")}.`);
  render();
}

function cpuBid(player) {
  const spades = player.hand.filter(card => card.suit === "spades").length;
  const high = player.hand.filter(card => card.rankValue >= 12).length;
  return clamp(Math.round(spades * 0.7 + high * 0.45), 1, player.hand.length);
}

function trumpAction(action, suit) {
  const game = state.game;
  if (game.type !== "euchre" || game.phase !== "trump") return;
  const playerIndex = game.currentBidder;
  if (action === "order") {
    setTrump(playerIndex, suit || game.upcard.suit, game.biddingRound === 1);
    return;
  }
  advanceTrumpBid();
}

function advanceTrumpBid() {
  const game = state.game;
  game.currentBidder = nextPlayer(game, game.currentBidder);
  if (game.currentBidder === nextPlayer(game, game.dealer)) {
    game.biddingRound += 1;
    if (game.biddingRound > 2) {
      const bestSuit = bestTrumpSuit(game.players[game.dealer], game.upcard.suit);
      setTrump(game.dealer, bestSuit, false);
      return;
    }
  }
  game.current = game.currentBidder;
  game.message = `${game.players[game.currentBidder].name} chooses trump`;
  render();
}

function setTrump(callerIndex, suit, pickUp) {
  const game = state.game;
  game.trump = suit;
  game.caller = callerIndex;
  if (pickUp) {
    const dealer = game.players[game.dealer];
    dealer.hand.push(game.upcard);
    const discard = chooseEuchreDiscard(dealer, suit);
    removeCard(dealer, discard.id);
    dealer.hand = sortHand(dealer.hand);
  }
  game.phase = "playing";
  game.current = nextPlayer(game, game.dealer);
  game.leader = game.current;
  game.message = `${game.players[game.current].name} leads`;
  logLine(`${game.players[callerIndex].name} calls ${suit}.`);
  render();
}

function chooseEuchreDiscard(player, trump) {
  return player.hand.slice().sort((a, b) => euchrePower(a, trump) - euchrePower(b, trump))[0];
}

function bestTrumpSuit(player, blockedSuit) {
  return SUITS.filter(suit => suit !== blockedSuit).map(suit => ({
    suit,
    score: player.hand.reduce((sum, card) => sum + euchrePower(card, suit), 0)
  })).sort((a, b) => b.score - a.score)[0].suit;
}

function cpuTrumpDecision(player) {
  const game = state.game;
  const suit = game.biddingRound === 1 ? game.upcard.suit : bestTrumpSuit(player, game.upcard.suit);
  const score = player.hand.reduce((sum, card) => sum + euchrePower(card, suit), 0);
  return score > (game.biddingRound === 1 ? 92 : 86) ? suit : null;
}

function effectiveSuit(card, trump) {
  if (card.rank === "J" && sameColor(card.suit, trump) && card.suit !== trump) return trump;
  return card.suit;
}

function sameColor(a, b) {
  return RED_SUITS.has(a) === RED_SUITS.has(b);
}

function euchrePower(card, trump) {
  if (card.rank === "J" && card.suit === trump) return 200;
  if (card.rank === "J" && sameColor(card.suit, trump) && card.suit !== trump) return 190;
  const base = { "9": 9, "10": 10, J: 11, Q: 12, K: 13, A: 14 }[card.rank];
  return effectiveSuit(card, trump) === trump ? 100 + base : base;
}

function runCpu() {
  const game = state.game;
  if (!game || state.screen !== "table") return;
  if (game.phase === "trump") {
    const player = game.players[game.currentBidder];
    if (player.cpu) {
      const suit = cpuTrumpDecision(player);
      suit ? setTrump(game.currentBidder, suit, game.biddingRound === 1) : advanceTrumpBid();
    }
    return;
  }
  if (game.phase !== "playing") return;
  const player = game.players[game.current];
  if (!player?.cpu) return;
  const card = chooseCpuCard(player);
  if (card) commitPlay(player, card.id);
}

function scheduleCpu() {
  clearTimeout(cpuTimer);
  const game = state.game;
  if (!game) return;
  const shouldAct = (game.phase === "playing" && game.players[game.current]?.cpu) ||
    (game.phase === "trump" && game.players[game.currentBidder]?.cpu);
  if (shouldAct) {
    cpuTimer = setTimeout(runCpu, 540);
  }
}

function winnerLabel() {
  const game = state.game;
  if (!game) return "";
  if (game.type === "hearts") {
    return game.players.slice().sort((a, b) => a.total - b.total)[0].name;
  }
  return game.players.slice().sort((a, b) => b.total - a.total)[0].name;
}

function cardButton(card, options = {}) {
  const selected = options.selected ? " is-selected" : "";
  const red = RED_SUITS.has(card.suit) ? " red" : "";
  const disabled = options.disabled ? " disabled" : "";
  const action = options.action || "play-card";
  return `<button class="card${red}${selected}" data-action="${action}" data-card="${card.id}"${disabled} aria-label="${card.rank} of ${card.suit}">
    <span class="card-rank">${card.rank}</span>
    <span class="card-center">${SUIT_SYMBOLS[card.suit]}</span>
    <span class="card-suit">${SUIT_SYMBOLS[card.suit]}</span>
  </button>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderTopbar() {
  return `<header class="topbar">
    <div class="brand">
      <div class="mark">TC</div>
      <div>
        <h1>Table Cards</h1>
        <p class="subtle">Hearts, Spades, Euchre</p>
      </div>
    </div>
    <div class="button-row">
      ${state.screen !== "setup" ? '<button class="btn" data-action="home">Home</button>' : ""}
      ${state.game ? '<button class="btn danger" data-action="new-lobby">Leave Table</button>' : ""}
    </div>
  </header>`;
}

function renderSetup() {
  const meta = GAMES[state.config.game];
  const sessions = getJoinableSessions(state.sessions);
  const selectedDifficulty = state.config.difficulties?.[state.config.game] || state.config.difficulty;
  return `${renderTopbar()}
  <section class="screen setup-grid">
    <div class="panel">
      <div class="panel-title"><h2>Coworker Queue</h2><span class="pill">${sessions.length} active</span></div>
      <div class="field-stack">
        <div class="field">
          <label for="playerName">Name</label>
          <input id="playerName" value="${escapeHtml(loadDisplayName())}" autocomplete="name">
        </div>
        <div class="field">
          <label for="playerCount">Seats</label>
          <input id="playerCount" type="number" min="${meta.min}" max="${meta.max}" value="${meta.defaultPlayers}" ${state.config.game === "euchre" ? "disabled" : ""}>
        </div>
        <div class="field">
          <label for="difficulty">${meta.title} CPU Difficulty</label>
          <select id="difficulty">${Object.entries(DIFFICULTY).map(([key, value]) => `<option value="${key}" ${key === selectedDifficulty ? "selected" : ""}>${value.label}</option>`).join("")}</select>
        </div>
        <div class="field">
          <label for="targetScore">Target Score</label>
          <input id="targetScore" type="number" min="5" max="500" value="${meta.target}">
        </div>
      </div>
      <div class="button-row">
        <button class="btn primary" data-action="play-solo">Play Solo</button>
        <button class="btn" data-action="create-lobby">Create Session</button>
        <button class="btn" data-action="refresh-sessions">Refresh</button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-title"><h2>Active Sessions</h2><span class="pill">${state.queueLoading ? "Refreshing" : "Live"}</span></div>
      <div class="session-list">
        ${sessions.length ? sessions.map(session => `<article class="session-card">
          <div>
            <h3>${escapeHtml(session.code)} · ${escapeHtml(session.hostName || session.host_name || "Host")}</h3>
            <p class="subtle">${escapeHtml(describeSessionStatus(session))}</p>
          </div>
          <button class="btn primary" data-action="join-session" data-code="${escapeHtml(session.code)}">${session.status === "playing" ? "Rejoin" : "Join"}</button>
        </article>`).join("") : '<p class="subtle">No active sessions yet. Create one and the table code will show here for everyone.</p>'}
      </div>
    </div>
    <div class="panel setup-wide">
      <div class="panel-title"><h2>Default Game</h2></div>
      <div class="game-list">
        ${Object.entries(GAMES).map(([key, game]) => `<button class="game-card" data-action="select-game" data-game="${key}" aria-pressed="${state.config.game === key}">
          <strong>${game.title}</strong>
          <span>${game.summary}</span>
          <div class="pill-row"><span class="pill">${game.range}</span><span class="pill">${game.target} target</span><span class="pill">CPU ${DIFFICULTY[state.config.difficulties?.[key] || state.config.difficulty].label}</span></div>
        </button>`).join("")}
      </div>
    </div>
  </section>`;
}

function renderLobby() {
  const lobby = state.lobby;
  const meta = GAMES[lobby.config.game];
  const shareUrl = makeSessionShareUrl(window.location.href, lobby.code);
  const host = isHost(lobby);
  const seat = currentSeat(lobby);
  const readyToLaunch = canLaunchSession({ player_count: lobby.config.players, players: lobby.seats });
  return `${renderTopbar()}
  <section class="screen lobby-grid">
    <div class="panel">
      <div class="panel-title"><h2>${meta.title} Session</h2><span class="pill">${lobby.status === "playing" ? "In progress" : "Lobby"}</span></div>
      <div class="hub-code">
        <div><span class="label">Code</span><strong>${lobby.code}</strong></div>
        <button class="btn" data-action="copy-link">Copy Link</button>
      </div>
      <div class="field">
        <label for="hubLink">Invite Link</label>
        <input id="hubLink" value="${escapeHtml(shareUrl)}" readonly>
      </div>
      <div class="host-panel">
        <div class="panel-title"><h2>Your Seat</h2><span class="pill">${seat ? `Seat ${seat.seat_index + 1}` : "Not seated"}</span></div>
        <div class="field">
          <label for="lobbyPlayerName">Your Name</label>
          <input id="lobbyPlayerName" value="${escapeHtml(seat?.name || loadDisplayName())}" autocomplete="name">
        </div>
        <div class="button-row">
          <button class="btn" data-action="save-player-name">Save Name</button>
          ${!seat && lobby.status === "lobby" ? '<button class="btn primary" data-action="join-current-session">Join Session</button>' : ""}
        </div>
      </div>
      <div class="button-row">
        ${seat && lobby.status !== "playing" ? `<button class="btn" data-action="toggle-ready">${seat.is_ready ? "Mark Not Ready" : "Ready Up"}</button>` : ""}
        ${lobby.status === "playing" ? '<button class="btn primary" data-action="start-game">Open Table</button>' : ""}
        <button class="btn" data-action="refresh-lobby">Refresh</button>
        <button class="btn danger" data-action="leave-session">${seat?.is_host ? "Back To Queue" : "Leave Session"}</button>
      </div>
      ${host ? `<div class="host-panel">
        <div class="panel-title"><h2>Host Controls</h2><span class="pill">${readyToLaunch ? "Ready" : "Needs seats"}</span></div>
        <div class="field-stack">
          <div class="field">
            <label for="hostGame">Game</label>
            <select id="hostGame">${Object.entries(GAMES).map(([key, game]) => `<option value="${key}" ${key === lobby.config.game ? "selected" : ""}>${game.title}</option>`).join("")}</select>
          </div>
          <div class="field">
            <label for="hostPlayerCount">Seats</label>
            <input id="hostPlayerCount" type="number" min="${meta.min}" max="${meta.max}" value="${lobby.config.players}" ${lobby.config.game === "euchre" ? "disabled" : ""}>
          </div>
          <div class="field">
            <label for="hostTargetScore">Target Score</label>
            <input id="hostTargetScore" type="number" min="5" max="500" value="${lobby.config.target}">
          </div>
        </div>
        <div class="button-row">
          <button class="btn" data-action="save-host-settings">Save Setup</button>
          <button class="btn" data-action="fill-cpus">Fill CPUs</button>
          <button class="btn primary" data-action="start-game" ${readyToLaunch ? "" : "disabled"}>Launch Table</button>
        </div>
      </div>` : ""}
    </div>
    <div class="panel">
      <div class="panel-title"><h2>Seats</h2><span class="pill">${lobby.seats.length}/${lobby.config.players}</span></div>
      <div class="seats">
        ${Array.from({ length: lobby.config.players }, (_, index) => {
          const occupant = lobby.seats.find(player => player.seat_index === index);
          return `<article class="seat-card ${occupant?.client_id === state.clientId ? "is-you" : ""}">
            <h3>${escapeHtml(formatSeatLabel(occupant, index))}</h3>
            <p class="subtle">${occupant ? `${occupant.cpu ? DIFFICULTY[occupant.difficulty]?.label || "CPU" : "Coworker"} · Team ${lobby.config.game === "hearts" ? index + 1 : index % 2 + 1}` : "Waiting for a coworker or CPU."}</p>
          </article>`;
        }).join("")}
      </div>
    </div>
  </section>`;
}

function renderTable() {
  const game = state.game;
  const human = game.players[0];
  const legalIds = new Set(validCards(human).map(card => card.id));
  return `${renderTopbar()}
  <section class="screen table-grid">
    <div class="table">
      ${renderStatus(game)}
      ${renderSeats(game)}
      ${renderTrick(game)}
      <div class="hand-zone">
        <div class="hand-toolbar">
          <div>
            <strong>Your Hand</strong>
            <p class="subtle">${game.message}</p>
          </div>
          <div class="button-row">${renderPhaseButtons(game)}</div>
        </div>
        <div class="hand">
          ${human.hand.map(card => {
            if (game.phase === "passing") return cardButton(card, { action: "select-pass", selected: state.selectedPass.has(card.id) });
            return cardButton(card, { disabled: !legalIds.has(card.id) || game.current !== 0 || game.phase !== "playing" });
          }).join("")}
        </div>
      </div>
    </div>
    <aside class="side-panel">
      <div class="panel">
        <div class="panel-title"><h2>Score</h2><span class="pill">${winnerLabel()}</span></div>
        <div class="score-list">${renderScoreRows(game)}</div>
      </div>
      <div class="panel">
        <div class="panel-title"><h2>Table Log</h2></div>
        <div class="log">${game.log.map(item => `<div>${item}</div>`).join("") || '<div class="subtle">No plays yet.</div>'}</div>
      </div>
    </aside>
  </section>
  ${renderActionPanel(game)}`;
}

function renderStatus(game) {
  const phase = game.phase === "roundover" || game.phase === "gameover" ? game.phase : game.message;
  return `<div class="status-strip">
    <div class="stat"><span>Game</span><strong>${GAMES[game.type].title}</strong></div>
    <div class="stat"><span>Round</span><strong>${game.round}</strong></div>
    <div class="stat"><span>Turn</span><strong>${game.players[game.current]?.name || "Table"}</strong></div>
    <div class="stat"><span>State</span><strong>${phase}</strong></div>
  </div>`;
}

function renderSeats(game) {
  const positions = SEAT_POSITIONS[game.players.length - 1] || SEAT_POSITIONS[3];
  return game.players.map((player, index) => `<div class="seat ${positions[index]} ${game.current === index ? "is-turn" : ""}">
    <strong>${player.name}</strong>
    <div class="seat-meta"><span>${player.hand.length} cards</span><span>${player.tricks} tricks</span></div>
    <div class="mini-cards">${Array.from({ length: Math.min(player.hand.length, 12) }, () => '<span class="mini-card"></span>').join("")}</div>
  </div>`).join("");
}

function renderTrick(game) {
  return `<div class="trick-zone">
    ${game.trick.map(play => `<div class="played-card">${cardButton(play.card, { disabled: true })}<small>${game.players[play.player].name}</small></div>`).join("")}
  </div>`;
}

function renderPhaseButtons(game) {
  if (game.phase === "passing") {
    return `<button class="btn primary" data-action="confirm-pass" ${state.selectedPass.size === 3 ? "" : "disabled"}>Pass 3</button>`;
  }
  if (game.phase === "roundover") {
    return '<button class="btn primary" data-action="new-round">Next Round</button>';
  }
  if (game.phase === "gameover") {
    return '<button class="btn primary" data-action="new-lobby">New Match</button>';
  }
  return "";
}

function renderScoreRows(game) {
  return game.players.map((player, index) => `<div class="score-row ${game.current === index ? "is-turn" : ""}">
    <div>
      <strong>${player.name}</strong>
      <p class="subtle">${scoreSubline(game, player)}</p>
    </div>
    <strong>${player.total}</strong>
  </div>`).join("");
}

function scoreSubline(game, player) {
  if (game.type === "hearts") return `${player.roundPoints} round points`;
  if (game.type === "spades") return `Team ${player.team + 1} · ${player.tricks}/${player.bid ?? "-"} tricks`;
  return `Team ${player.team + 1} · ${player.tricks} tricks`;
}

function renderActionPanel(game) {
  if (game.phase === "received") {
    return `<div class="action-panel">
      <div class="panel-title"><h2>Cards Received</h2><span class="pill">${game.passDirection}</span></div>
      <div class="hand">${state.pendingReceived.map(card => cardButton(card, { disabled: true })).join("")}</div>
      <div class="button-row"><button class="btn primary" data-action="take-received">Place In Hand</button></div>
    </div>`;
  }
  if (game.phase === "bidding") {
    return `<div class="action-panel">
      <div class="panel-title"><h2>Bid</h2><span class="pill">${game.players[0].hand.length} cards</span></div>
      <div class="field"><label for="bidInput">Your Bid</label><input id="bidInput" type="number" min="0" max="${game.players[0].hand.length}" value="3"></div>
      <div class="button-row"><button class="btn primary" data-action="submit-bid">Lock Bid</button></div>
    </div>`;
  }
  if (game.phase === "trump" && game.players[game.currentBidder].human) {
    const choices = game.biddingRound === 1 ? [game.upcard.suit] : SUITS.filter(suit => suit !== game.upcard.suit);
    return `<div class="action-panel">
      <div class="panel-title"><h2>Trump</h2><span class="pill">Upcard ${game.upcard.rank}${SUIT_SYMBOLS[game.upcard.suit]}</span></div>
      <div class="button-row">
        ${choices.map(suit => `<button class="btn primary" data-action="trump-order" data-suit="${suit}">${SUIT_SYMBOLS[suit]} ${suit}</button>`).join("")}
        <button class="btn" data-action="trump-pass">Pass</button>
      </div>
    </div>`;
  }
  return "";
}

function toast(message) {
  state.toast = message;
  render();
  setTimeout(() => {
    if (state.toast === message) {
      state.toast = "";
      render();
    }
  }, 2200);
}

async function getSupabaseClient() {
  const config = window.TABLE_CARDS_SUPABASE;
  if (!config?.url || !config?.publishableKey) return null;
  if (!supabaseClientPromise) {
    supabaseClientPromise = import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm")
      .then(module => module.createClient(config.url, config.publishableKey));
  }
  return supabaseClientPromise;
}

async function syncLobbyToSupabase(lobby) {
  const supabase = await getSupabaseClient();
  if (!supabase) return false;
  try {
    const { data, error } = await supabase
      .from("table_cards_lobbies")
      .insert({
        code: lobby.code,
        game: lobby.config.game,
        target_score: lobby.config.target,
        player_count: lobby.config.players,
        host_name: lobby.config.playerName
      })
      .select("id")
      .single();
    if (error) throw error;
    lobby.backendId = data.id;
    const { error: seatError } = await supabase.from("table_cards_players").insert(lobby.seats.map((seat, index) => ({
      lobby_id: data.id,
      client_id: state.clientId,
      name: seat.name,
      seat_index: index,
      is_cpu: seat.cpu,
      is_host: index === 0,
      is_ready: true,
      difficulty: seat.difficulty
    })));
    if (seatError) throw seatError;
    toast("Hub synced");
    return true;
  } catch (error) {
    console.warn("Supabase lobby sync failed", error);
    toast("Local hub active");
    return false;
  }
}

async function loadLobbyFromSupabase(code) {
  const supabase = await getSupabaseClient();
  if (!supabase) return null;
  const { data: lobby, error } = await supabase
    .from("table_cards_lobbies")
    .select("id, code, game, target_score, player_count, host_name, status, created_at, updated_at")
    .eq("code", code)
    .maybeSingle();
  if (error || !lobby) return null;
  const { data: players, error: playerError } = await supabase
    .from("table_cards_players")
    .select("id, client_id, name, seat_index, is_cpu, is_host, is_ready, difficulty, last_seen")
    .eq("lobby_id", lobby.id)
    .order("seat_index", { ascending: true });
  if (playerError) return null;
  return mapRemoteLobby(lobby, players || []);
}

function mapRemoteLobby(lobby, players) {
  return {
    id: uid("lobby"),
    backendId: lobby.id,
    code: lobby.code,
    status: lobby.status,
    createdAt: lobby.created_at || new Date().toISOString(),
    updatedAt: lobby.updated_at || new Date().toISOString(),
    hostName: lobby.host_name,
    player_count: lobby.player_count,
    game: lobby.game,
    target_score: lobby.target_score,
    players,
    config: {
      game: lobby.game,
      players: lobby.player_count,
      difficulty: "normal",
      target: lobby.target_score,
      playerName: state.config.playerName
    },
    seats: players.map((seat, index) => ({
      id: seat.id || uid("player"),
      backendId: seat.id,
      client_id: seat.client_id,
      name: seat.name,
      human: seat.client_id === state.clientId && !seat.is_cpu,
      cpu: seat.is_cpu,
      is_host: seat.is_host,
      is_ready: seat.is_ready,
      seat_index: seat.seat_index,
      difficulty: seat.difficulty || "normal",
      total: 0,
      hand: [],
      taken: [],
      tricks: 0,
      bid: null,
      team: lobby.game === "euchre" ? seat.seat_index % 2 : lobby.player_count % 2 === 0 && lobby.game === "spades" ? seat.seat_index % 2 : index
    }))
  };
}

async function refreshSessions() {
  const supabase = await getSupabaseClient();
  if (!supabase) return;
  state.queueLoading = true;
  const { data: lobbies, error } = await supabase
    .from("table_cards_lobbies")
    .select("id, code, game, target_score, player_count, host_name, status, created_at, updated_at")
    .in("status", ["lobby", "playing"])
    .order("updated_at", { ascending: false })
    .limit(20);
  if (error) {
    state.queueLoading = false;
    toast("Could not load sessions");
    return;
  }
  const ids = (lobbies || []).map(lobby => lobby.id);
  let players = [];
  if (ids.length) {
    const result = await supabase
      .from("table_cards_players")
      .select("id, lobby_id, client_id, name, seat_index, is_cpu, is_host, is_ready, difficulty, last_seen")
      .in("lobby_id", ids)
      .order("seat_index", { ascending: true });
    players = result.data || [];
  }
  state.sessions = (lobbies || []).map(lobby => mapRemoteLobby(lobby, players.filter(player => player.lobby_id === lobby.id)));
  state.queueLoading = false;
  if (state.screen === "setup") render();
}

async function refreshLobby(code = state.lobby?.code) {
  if (!code) return null;
  const lobby = await loadLobbyFromSupabase(code);
  if (!lobby) return null;
  state.lobby = lobby;
  state.config = { ...state.config, ...lobby.config };
  if (lobby.status === "playing" && !state.game && currentSeat(lobby)) {
    createGameFromLobby();
    return lobby;
  }
  if (state.screen === "lobby") render();
  return lobby;
}

function currentSeat(lobby = state.lobby) {
  return lobby?.seats?.find(seat => seat.client_id === state.clientId && !seat.cpu) || null;
}

function isHost(lobby = state.lobby) {
  return Boolean(currentSeat(lobby)?.is_host);
}

function openSeatIndexes(lobby) {
  const occupied = new Set((lobby.seats || []).map(seat => seat.seat_index));
  return Array.from({ length: lobby.config.players }, (_, index) => index).filter(index => !occupied.has(index));
}

async function joinLobby(code) {
  if (!code) return;
  const nameInput = document.querySelector("#lobbyPlayerName") || document.querySelector("#playerName");
  const playerName = saveDisplayName(nameInput?.value || loadDisplayName());
  const lobby = await loadLobbyFromSupabase(code);
  if (!lobby) {
    toast("Session not found");
    return;
  }
  state.lobby = lobby;
  state.screen = "lobby";
  updateUrlLobby(lobby.code);
  if (currentSeat(lobby) || lobby.status === "playing") {
    render();
    return;
  }
  const open = openSeatIndexes(lobby)[0];
  if (open === undefined) {
    toast("Session is full");
    render();
    return;
  }
  const optimisticSeat = {
    id: uid("player"),
    client_id: state.clientId,
    name: playerName,
    human: true,
    cpu: false,
    difficulty: state.config.difficulty,
    total: 0,
    hand: [],
    taken: [],
    tricks: 0,
    bid: null,
    team: lobby.config.game === "euchre" ? open % 2 : lobby.config.players % 2 === 0 && lobby.config.game === "spades" ? open % 2 : open,
    seat_index: open,
    is_host: false,
    is_ready: false
  };
  const supabase = await getSupabaseClient();
  const { error } = await supabase.from("table_cards_players").insert({
    lobby_id: lobby.backendId,
    client_id: state.clientId,
    name: playerName,
    seat_index: open,
    is_cpu: false,
    is_host: false,
    is_ready: false,
    difficulty: state.config.difficulty
  });
  if (error) {
    toast("Seat was taken. Refreshing");
  } else {
    state.lobby.seats = state.lobby.seats.concat(optimisticSeat).sort((a, b) => a.seat_index - b.seat_index);
    render();
    toast(`Joined as ${playerName}`);
  }
  const refreshed = await refreshLobby(lobby.code);
  if (!error && refreshed && !currentSeat(refreshed)) {
    state.lobby.seats = refreshed.seats.concat(optimisticSeat).sort((a, b) => a.seat_index - b.seat_index);
    render();
  }
  await refreshSessions();
}

async function toggleReady() {
  const seat = currentSeat();
  if (!seat) return;
  const supabase = await getSupabaseClient();
  await supabase
    .from("table_cards_players")
    .update({ is_ready: !seat.is_ready, last_seen: new Date().toISOString() })
    .eq("id", seat.backendId);
  await refreshLobby();
}

async function savePlayerName() {
  const nextName = saveDisplayName(document.querySelector("#lobbyPlayerName")?.value || loadDisplayName());
  const seat = currentSeat();
  if (!seat) {
    toast("Name saved");
    render();
    return;
  }
  seat.name = nextName;
  if (state.game?.players?.[0]?.human) state.game.players[0].name = nextName;
  render();
  const supabase = await getSupabaseClient();
  if (supabase && seat.backendId) {
    await supabase
      .from("table_cards_players")
      .update({ name: nextName, last_seen: new Date().toISOString() })
      .eq("id", seat.backendId);
    if (seat.is_host && state.lobby?.backendId) {
      await supabase
        .from("table_cards_lobbies")
        .update({ host_name: nextName, updated_at: new Date().toISOString() })
        .eq("id", state.lobby.backendId);
    }
  }
  await refreshLobby();
  toast("Name updated");
}

async function leaveLobby() {
  const seat = currentSeat();
  const supabase = await getSupabaseClient();
  if (seat && !seat.is_host) {
    await supabase.from("table_cards_players").delete().eq("id", seat.backendId);
  }
  state.lobby = null;
  state.game = null;
  state.screen = "setup";
  history.replaceState({}, "", new URL(window.location.pathname, window.location.origin).href);
  await refreshSessions();
  render();
}

async function saveHostSettings() {
  if (!isHost()) return;
  const game = document.querySelector("#hostGame")?.value || state.lobby.config.game;
  const meta = GAMES[game];
  const count = game === "euchre" ? 4 : clamp(Number(document.querySelector("#hostPlayerCount")?.value || meta.defaultPlayers), meta.min, meta.max);
  const target = Number(document.querySelector("#hostTargetScore")?.value || meta.target);
  const supabase = await getSupabaseClient();
  await supabase
    .from("table_cards_lobbies")
    .update({ game, player_count: count, target_score: target, updated_at: new Date().toISOString() })
    .eq("id", state.lobby.backendId);
  await refreshLobby();
  await refreshSessions();
  toast("Session updated");
}

async function fillCpuSeats() {
  if (!isHost()) return;
  const lobby = state.lobby;
  const open = openSeatIndexes(lobby);
  if (!open.length) {
    toast("All seats are filled");
    return;
  }
  const cpuSeats = open.map(index => ({
    id: uid("player"),
    client_id: `cpu-${lobby.code}-${index}`,
    name: `CPU ${index}`,
    human: false,
    cpu: true,
    difficulty: lobby.config.difficulty,
    total: 0,
    hand: [],
    taken: [],
    tricks: 0,
    bid: null,
    team: lobby.config.game === "euchre" ? index % 2 : lobby.config.players % 2 === 0 && lobby.config.game === "spades" ? index % 2 : index,
    seat_index: index,
    is_host: false,
    is_ready: true
  }));
  const supabase = await getSupabaseClient();
  let synced = false;
  if (supabase && lobby.backendId) {
    const { error } = await supabase.from("table_cards_players").insert(cpuSeats.map(seat => ({
      lobby_id: lobby.backendId,
      client_id: seat.client_id,
      name: seat.name,
      seat_index: seat.seat_index,
      is_cpu: true,
      is_host: false,
      is_ready: true,
      difficulty: seat.difficulty
    })));
    synced = !error;
    if (error) console.warn("CPU seat sync failed", error);
  }
  if (!synced) {
    lobby.seats = lobby.seats.concat(cpuSeats);
    render();
    toast("CPU seats filled locally");
    return;
  }
  await refreshLobby();
  await refreshSessions();
}

async function launchLobby() {
  const lobby = await refreshLobby() || state.lobby;
  if (lobby?.status === "playing") {
    createGameFromLobby();
    return;
  }
  if (!isHost()) return;
  if (!canLaunchSession({ player_count: lobby.config.players, players: lobby.seats })) {
    toast("Fill every seat before launch");
    return;
  }
  createGameFromLobby();
  await refreshSessions();
}

async function markLobbyPlaying(lobby) {
  if (!lobby?.backendId) return;
  const supabase = await getSupabaseClient();
  if (!supabase) return;
  await supabase
    .from("table_cards_lobbies")
    .update({ status: "playing", updated_at: new Date().toISOString() })
    .eq("id", lobby.backendId);
  await supabase
    .from("table_cards_events")
    .insert({ lobby_id: lobby.backendId, event_type: "game_started", payload: { game: lobby.config.game } });
}

function render() {
  if (state.screen === "setup") app.innerHTML = renderSetup();
  if (state.screen === "lobby") app.innerHTML = renderLobby();
  if (state.screen === "table") app.innerHTML = renderTable();
  if (state.toast) app.insertAdjacentHTML("beforeend", `<div class="toast">${state.toast}</div>`);
  scheduleCpu();
  scheduleQueueRefresh();
}

function scheduleQueueRefresh() {
  clearInterval(queueTimer);
  if (state.screen === "setup") {
    queueTimer = setInterval(() => void refreshSessions(), 8000);
  }
  if (state.screen === "lobby") {
    queueTimer = setInterval(() => void refreshLobby(), 4000);
  }
}

app.addEventListener("click", event => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "home") {
    state.screen = "setup";
    state.game = null;
    state.lobby = null;
    void refreshSessions();
    render();
  }
  if (action === "new-lobby") {
    state.screen = state.lobby ? "lobby" : "setup";
    state.game = null;
    render();
  }
  if (action === "select-game") {
    const game = target.dataset.game;
    state.config.game = game;
    state.config.difficulty = state.config.difficulties?.[game] || state.config.difficulty;
    state.config.target = GAMES[game].target;
    render();
  }
  if (action === "play-solo") createSoloGame();
  if (action === "create-lobby") void createLobby();
  if (action === "refresh-sessions") void refreshSessions();
  if (action === "join-session") void joinLobby(target.dataset.code);
  if (action === "join-current-session") void joinLobby(state.lobby?.code);
  if (action === "refresh-lobby") void refreshLobby();
  if (action === "toggle-ready") void toggleReady();
  if (action === "save-player-name") void savePlayerName();
  if (action === "leave-session") void leaveLobby();
  if (action === "save-host-settings") void saveHostSettings();
  if (action === "copy-link") {
    const input = document.querySelector("#hubLink");
    navigator.clipboard?.writeText(input.value);
    toast("Link copied");
  }
  if (action === "fill-cpus") void fillCpuSeats();
  if (action === "start-game") void launchLobby();
  if (action === "select-pass") {
    const id = target.dataset.card;
    state.selectedPass.has(id) ? state.selectedPass.delete(id) : state.selectedPass.add(id);
    if (state.selectedPass.size > 3) state.selectedPass.delete(Array.from(state.selectedPass)[0]);
    render();
  }
  if (action === "confirm-pass") confirmHeartsPass();
  if (action === "take-received") startHeartsPlay();
  if (action === "play-card") playCard(target.dataset.card);
  if (action === "submit-bid") submitBid();
  if (action === "trump-order") trumpAction("order", target.dataset.suit);
  if (action === "trump-pass") trumpAction("pass");
  if (action === "new-round") startRound();
});

app.addEventListener("change", event => {
  if (event.target.id !== "difficulty") return;
  state.config.difficulty = event.target.value;
  state.config.difficulties = { ...state.config.difficulties, [state.config.game]: event.target.value };
  render();
});

async function bootFromUrl() {
  state.config.playerName = loadDisplayName();
  const params = new URLSearchParams(window.location.search);
  const hub = params.get("hub");
  if (!hub) {
    await refreshSessions();
    return;
  }
  const remoteLobby = await loadLobbyFromSupabase(hub.toUpperCase());
  if (remoteLobby) {
    state.lobby = remoteLobby;
    state.config = { ...state.config, ...remoteLobby.config };
    state.screen = "lobby";
    render();
    return;
  }
  state.lobby = {
    id: uid("lobby"),
    code: hub.toUpperCase(),
    createdAt: new Date().toISOString(),
    config: { ...state.config },
    seats: makePlayers(state.config.players, state.config.playerName, state.config.difficulty, state.config.game)
  };
  state.screen = "lobby";
  render();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => undefined));
}

void bootFromUrl();
render();
