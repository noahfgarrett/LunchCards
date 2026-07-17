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
  easy: { label: "Easy", risk: 0.2, memory: 0.2, bid: 0.72, trump: 0.78 },
  normal: { label: "Normal", risk: 0.48, memory: 0.55, bid: 0.9, trump: 0.92 },
  hard: { label: "Hard", risk: 0.72, memory: 0.8, bid: 1, trump: 1 },
  expert: { label: "Expert", risk: 0.94, memory: 1, bid: 1.08, trump: 1.08 }
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
  connection: "connecting",
  connectionMessage: "Connecting to multiplayer",
  busyAction: "",
  game: null,
  gameVersion: 0,
  gameSyncing: false,
  reviewedReceivedVersion: 0,
  setupNameDraft: "",
  lobbyNameDraft: "",
  selectedPass: new Set(),
  selectedCard: null,
  pendingReceived: [],
  toast: ""
};
let cpuTimer = null;
let supabaseClientPromise = null;
let queueTimer = null;
let heartbeatTimer = null;
let realtimeChannel = null;
let realtimeCode = "";
let toastTimer = null;

function getClientId() {
  const legacyKey = "table-cards-client-id";
  const key = "lunch-cards-client-id";
  const storage = globalThis.localStorage;
  const existing = storage?.getItem(key);
  if (existing) return existing;
  const legacy = storage?.getItem(legacyKey);
  const next = legacy || (globalThis.crypto?.randomUUID ? crypto.randomUUID() : uid("client"));
  storage?.setItem(key, next);
  return next;
}

function saveDisplayName(name) {
  const next = sanitizeName(name);
  globalThis.localStorage?.setItem("lunch-cards-display-name", next);
  state.config.playerName = next;
  return next;
}

function sanitizeName(name) {
  const clean = String(name || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
  return clean || "Player";
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

function seatTokenKey(code) {
  return `lunch-cards-seat-token:${String(code || "").toUpperCase()}`;
}

function getSeatToken(code, create = false) {
  const key = seatTokenKey(code);
  const existing = globalThis.localStorage?.getItem(key);
  if (existing || !create) return existing || "";
  const token = randomToken();
  globalThis.localStorage?.setItem(key, token);
  return token;
}

function clearSeatToken(code) {
  globalThis.localStorage?.removeItem(seatTokenKey(code));
}

function setConnection(status, message) {
  state.connection = status;
  state.connectionMessage = message;
}

function captureSetupDraft() {
  const players = Number(document.querySelector("#playerCount")?.value);
  const target = Number(document.querySelector("#targetScore")?.value);
  if (Number.isFinite(players)) state.config.players = players;
  if (Number.isFinite(target)) state.config.target = target;
}

function loadDisplayName() {
  const storage = globalThis.localStorage;
  return storage?.getItem("lunch-cards-display-name") || storage?.getItem("table-cards-display-name") || state.config.playerName || "Player";
}

function isEditingLobbyName() {
  return state.screen === "lobby" && document.activeElement?.id === "lobbyPlayerName";
}

function isEditingSetupName() {
  return state.screen === "setup" && document.activeElement?.id === "playerName";
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

function nextActivePlayer(game, from = game.current) {
  let next = nextPlayer(game, from);
  while (next === game.sittingOut) next = nextPlayer(game, next);
  return next;
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
  const playerName = saveDisplayName(document.querySelector("#playerName")?.value || state.setupNameDraft || loadDisplayName());
  state.setupNameDraft = playerName;
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
  state.busyAction = "create";
  render();
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
  const synced = await syncLobbyToSupabase(lobby);
  state.busyAction = "";
  if (!synced) {
    state.lobby = null;
    state.screen = "setup";
    render();
    return;
  }
  state.lobby = lobby;
  state.screen = "lobby";
  updateUrlLobby(lobby.code);
  await refreshLobby(lobby.code);
  subscribeToLobby(lobby.code);
  await refreshSessions();
  render();
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
  state.gameVersion = 0;
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

function createGameFromLobby(options = {}) {
  const { config, seats } = state.lobby;
  const orderedSeats = seats.slice().sort((a, b) => a.seat_index - b.seat_index);
  const players = orderedSeats.map(player => ({
    ...player,
    human: player.client_id === state.clientId && !player.cpu,
    cpu: Boolean(player.cpu),
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
    caller: null,
    alone: false,
    sittingOut: null,
    teamBags: {},
    playerBags: {}
  };
  state.game = base;
  state.gameVersion = 0;
  state.screen = "table";
  startRound({ renderNow: options.renderNow !== false });
  return base;
}

function localPlayerIndex(game = state.game) {
  if (!game) return -1;
  return game.players.findIndex(player => player.client_id === state.clientId && !player.cpu);
}

function localPlayer(game = state.game) {
  const index = localPlayerIndex(game);
  return index >= 0 ? game.players[index] : null;
}

function isSharedGame() {
  return Boolean(state.lobby?.backendId && state.lobby?.code !== "SOLO");
}

function isGameAuthority() {
  return !isSharedGame() || isHost();
}

function serializeGame(game = state.game) {
  return JSON.parse(JSON.stringify(game, (key, value) => key === "human" ? undefined : value));
}

function hydrateSharedGame(gameState, version) {
  if (!gameState?.players?.length) return false;
  const preservedPass = new Set(state.selectedPass);
  const hydrated = structuredClone(gameState);
  hydrated.players = hydrated.players.map(player => ({
    ...player,
    human: player.client_id === state.clientId && !player.cpu,
    cpu: Boolean(player.cpu)
  }));
  state.game = hydrated;
  state.gameVersion = Number(version || 0);
  state.screen = "table";
  const playerIndex = localPlayerIndex(hydrated);
  state.selectedPass = hydrated.passSelections?.[String(playerIndex)] ? new Set() : preservedPass;
  state.pendingReceived = hydrated.receivedCards?.[String(localPlayerIndex(hydrated))] || [];
  return true;
}

function logLine(text) {
  state.game.log.unshift(text);
  state.game.log = state.game.log.slice(0, 24);
}

function startRound(options = {}) {
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
    game.passSelections = {};
    game.receivedCards = {};
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
    game.alone = false;
    game.sittingOut = null;
    game.phase = "trump";
    game.biddingRound = 1;
    game.currentBidder = nextPlayer(game, game.dealer);
    game.current = game.currentBidder;
    game.message = `${game.upcard.suit} is up`;
    logLine(`Round ${game.round}: ${game.players[game.dealer].name} deals ${game.upcard.rank}${SUIT_SYMBOLS[game.upcard.suit]}.`);
  }
  if (options.renderNow !== false) render();
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
  if (difficulty === DIFFICULTY.easy) return player.hand.slice(-3).map(card => card.id);
  const suitCounts = Object.fromEntries(SUITS.map(suit => [suit, player.hand.filter(card => card.suit === suit).length]));
  const risky = player.hand.slice().sort((a, b) => {
    const voidBonusA = difficulty.memory > 0.7 && suitCounts[a.suit] <= 2 ? 5 : 0;
    const voidBonusB = difficulty.memory > 0.7 && suitCounts[b.suit] <= 2 ? 5 : 0;
    return heartsRisk(b, difficulty) + voidBonusB - heartsRisk(a, difficulty) - voidBonusA;
  });
  return risky.slice(0, 3).map(card => card.id);
}

function heartsRisk(card, difficulty) {
  let value = card.rankValue;
  if (card.suit === "hearts") value += 6;
  if (card.suit === "spades" && card.rank === "Q") value += 24;
  if (card.suit === "spades" && ["K", "A"].includes(card.rank)) value += 8;
  return value * (0.72 + difficulty.risk * 0.5);
}

async function confirmHeartsPass() {
  const game = state.game;
  if (state.selectedPass.size !== 3) {
    toast("Pick exactly 3 cards");
    return;
  }
  const playerIndex = localPlayerIndex(game);
  if (playerIndex < 0) return;
  game.passSelections ||= {};
  const selectedCards = Array.from(state.selectedPass);
  game.passSelections[String(playerIndex)] = selectedCards;
  if (isGameAuthority()) fillCpuPassSelections(game);
  state.selectedPass.clear();
  game.message = "Waiting for everyone to pass";
  if (allPassesReady(game)) applyHeartsPasses(game);
  render();
  const saved = await persistGameState();
  if (!saved && isSharedGame() && state.game?.phase === "passing") {
    const refreshedIndex = localPlayerIndex();
    if (!state.game.passSelections?.[String(refreshedIndex)]) {
      state.game.passSelections ||= {};
      state.game.passSelections[String(refreshedIndex)] = selectedCards;
      state.game.message = "Waiting for everyone to pass";
      render();
      await persistGameState();
    }
  }
}

function fillCpuPassSelections(game) {
  game.players.forEach((player, index) => {
    if (player.cpu && !game.passSelections?.[String(index)]) {
      game.passSelections[String(index)] = chooseHeartsPass(player, DIFFICULTY[player.difficulty] || DIFFICULTY.normal);
    }
  });
}

function allPassesReady(game) {
  return game.players.every((player, index) => player.cpu || game.passSelections?.[String(index)]?.length === 3) &&
    game.players.filter(player => player.cpu).every((player, index) => {
      const actualIndex = game.players.indexOf(player);
      return game.passSelections?.[String(actualIndex)]?.length === 3;
    });
}

function applyHeartsPasses(game) {
  const passes = game.players.map((player, index) => {
    const ids = game.passSelections[String(index)] || [];
    const cards = ids.map(id => removeCard(player, id)).filter(Boolean);
    return { cards, target: passTarget(index, game.passDirection, game.players.length) };
  });
  game.receivedCards = {};
  passes.forEach(pass => {
    game.players[pass.target].hand.push(...pass.cards);
    game.receivedCards[String(pass.target)] = pass.cards;
  });
  game.players.forEach(player => {
    player.hand = sortHand(player.hand);
  });
  startHeartsPlay({ renderNow: false });
  logLine("Passing is complete.");
  state.pendingReceived = game.receivedCards[String(localPlayerIndex(game))] || [];
}

function startHeartsPlay(options = {}) {
  const game = state.game;
  game.phase = "playing";
  const opener = game.players.findIndex(player => player.hand.some(card => card.id === "2-clubs"));
  game.current = opener >= 0 ? opener : lowestClubHolder(game);
  game.leader = game.current;
  game.message = `${game.players[game.current].name} leads`;
  state.pendingReceived = [];
  if (options.renderNow !== false) render();
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
      const lowestClub = player.hand.filter(card => card.suit === "clubs").sort((a, b) => a.rankValue - b.rankValue)[0];
      if (lowestClub && game.current === lowestClubHolder(game)) return [lowestClub];
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

async function playCard(cardIdValue) {
  const game = state.game;
  const player = game.players[game.current];
  const legal = validCards(player).some(card => card.id === cardIdValue);
  if (!legal || !player.human) {
    toast("That card is not live");
    return;
  }
  await commitPlay(player, cardIdValue);
}

async function commitPlay(player, cardIdValue) {
  const game = state.game;
  const card = removeCard(player, cardIdValue);
  if (!card) return;
  if (card.suit === "hearts") game.heartsBroken = true;
  if (card.suit === "spades") game.spadesBroken = true;
  game.lastTrick = null;
  game.trick.push({ player: game.current, card });
  logLine(`${player.name} plays ${card.rank}${SUIT_SYMBOLS[card.suit]}.`);
  const activePlayerCount = game.players.length - (game.sittingOut === null ? 0 : 1);
  if (game.trick.length === activePlayerCount) {
    resolveTrick();
  } else {
    game.current = nextActivePlayer(game);
    game.message = `${game.players[game.current].name}'s turn`;
  }
  render();
  await persistGameState();
}

function resolveTrick() {
  const game = state.game;
  const winner = trickWinner(game);
  const winnerPlayer = game.players[winner];
  winnerPlayer.taken.push(...game.trick.map(play => play.card));
  winnerPlayer.tricks += 1;
  const points = trickPoints(game);
  winnerPlayer.roundPoints += points;
  game.lastTrick = {
    plays: game.trick.map(play => ({ player: play.player, card: play.card })),
    winner,
    number: game.trickNumber,
    points
  };
  game.trick = [];
  game.current = winner;
  game.leader = winner;
  logLine(`${winnerPlayer.name} takes trick ${game.trickNumber}${points ? ` for ${points}` : ""}.`);
  game.trickNumber += 1;
  if (game.players.every((player, index) => index === game.sittingOut || player.hand.length === 0)) {
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
      const bid = teamPlayers.reduce((sum, player) => sum + (Number(player.bid || 0) > 0 ? Number(player.bid) : 0), 0);
      const tricks = teamPlayers.reduce((sum, player) => sum + player.tricks, 0);
      const bags = tricks >= bid ? tricks - bid : 0;
      game.teamBags[team] = Number(game.teamBags[team] || 0) + bags;
      let delta = tricks >= bid ? bid * 10 + bags : bid * -10;
      while (game.teamBags[team] >= 10) {
        delta -= 100;
        game.teamBags[team] -= 10;
      }
      teamPlayers.filter(player => Number(player.bid) === 0).forEach(player => {
        delta += player.tricks === 0 ? 100 : -100;
      });
      teamPlayers.forEach(player => {
        player.total += delta;
      });
      logLine(`Team ${team + 1} ${tricks >= bid ? "makes" : "misses"} ${bid}; ${game.teamBags[team]} bags.`);
    });
    return;
  }
  game.players.forEach((player, index) => {
    const bid = Number(player.bid || 0);
    if (bid === 0) {
      player.total += player.tricks === 0 ? 100 : -100;
      return;
    }
    if (player.tricks >= bid) {
      const bags = player.tricks - bid;
      game.playerBags[index] = Number(game.playerBags[index] || 0) + bags;
      player.total += bid * 10 + bags;
      while (game.playerBags[index] >= 10) {
        player.total -= 100;
        game.playerBags[index] -= 10;
      }
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
  if (callerTricks >= 5) points = game.alone ? 4 : 2;
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
    if (player.difficulty === "easy") return sorted[sorted.length - 1];
    if (!game.trick.length) return sorted[0];
    if (["hard", "expert"].includes(player.difficulty)) {
      const safe = sorted.filter(card => !wouldCardWin(game, card));
      return safe[safe.length - 1] || sorted[0];
    }
    return sorted[sorted.length - 1];
  }
  if (game.type === "spades") {
    return chooseSpadesCpuCard(game, legal, player);
  }
  return chooseEuchreCpuCard(game, legal, player);
}

function wouldCardWin(game, card) {
  const playerIndex = game.current;
  const original = game.trick;
  game.trick = original.concat({ player: playerIndex, card });
  const winner = trickWinner(game);
  game.trick = original;
  return winner === playerIndex;
}

function chooseSpadesCpuCard(game, legal, player) {
  const needsTrick = player.tricks < Number(player.bid || 0);
  const ranked = legal.slice().sort((a, b) => a.rankValue - b.rankValue);
  if (player.difficulty === "easy") return ranked[Math.floor(ranked.length / 2)];
  if (!game.trick.length) return needsTrick ? ranked[ranked.length - 1] : ranked[0];
  const winners = ranked.filter(card => wouldCardWin(game, card));
  if (needsTrick) return winners[0] || ranked[ranked.length - 1];
  return ranked.find(card => !wouldCardWin(game, card)) || ranked[0];
}

function chooseEuchreCpuCard(game, legal, player) {
  const ranked = legal.slice().sort((a, b) => euchrePower(a, game.trump) - euchrePower(b, game.trump));
  if (player.difficulty === "easy") return ranked[0];
  if (!game.trick.length) return ["hard", "expert"].includes(player.difficulty) ? ranked[ranked.length - 1] : ranked[0];
  const winners = ranked.filter(card => wouldCardWin(game, card));
  return winners[0] || ranked[0];
}

async function submitBid() {
  const game = state.game;
  const human = game.players[game.current];
  if (!human?.human) return;
  human.bid = clamp(Number(document.querySelector("#bidInput")?.value || 1), 0, human.hand.length);
  logLine(`${human.name} bids ${human.bid}.`);
  advanceSpadesBid(game);
  render();
  await persistGameState();
}

function advanceSpadesBid(game) {
  if (game.players.every(player => player.bid !== null)) {
    game.phase = "playing";
    game.current = nextPlayer(game, game.dealer);
    game.leader = game.current;
    game.message = `${game.players[game.current].name} leads`;
    logLine(`Bids are in: ${game.players.map(player => `${player.name} ${player.bid}`).join(", ")}.`);
    return;
  }
  game.current = nextPlayer(game);
  game.message = `${game.players[game.current].name} bids`;
}

function cpuBid(player) {
  const spades = player.hand.filter(card => card.suit === "spades").length;
  const high = player.hand.filter(card => card.rankValue >= 12).length;
  const profile = DIFFICULTY[player.difficulty] || DIFFICULTY.normal;
  const estimate = (spades * 0.62 + high * 0.42) * profile.bid;
  if (player.difficulty === "easy") return clamp(Math.round(estimate + (player.hand.length % 3) - 1), 1, player.hand.length);
  return clamp(Math.round(estimate), 1, player.hand.length);
}

async function trumpAction(action, suit) {
  const game = state.game;
  if (game.type !== "euchre" || game.phase !== "trump") return;
  const playerIndex = game.currentBidder;
  if (action === "order" || action === "alone") {
    setTrump(playerIndex, suit || game.upcard.suit, game.biddingRound === 1, action === "alone");
  } else {
    advanceTrumpBid();
  }
  await persistGameState();
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

function setTrump(callerIndex, suit, pickUp, alone = false) {
  const game = state.game;
  game.trump = suit;
  game.caller = callerIndex;
  game.alone = alone;
  game.sittingOut = alone ? (callerIndex + 2) % game.players.length : null;
  if (pickUp) {
    const dealer = game.players[game.dealer];
    dealer.hand.push(game.upcard);
    const discard = chooseEuchreDiscard(dealer, suit);
    removeCard(dealer, discard.id);
    dealer.hand = sortHand(dealer.hand);
  }
  game.phase = "playing";
  game.current = nextActivePlayer(game, game.dealer);
  game.leader = game.current;
  game.message = `${game.players[game.current].name} leads`;
  logLine(`${game.players[callerIndex].name} calls ${suit}${alone ? " and goes alone" : ""}.`);
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
  const profile = DIFFICULTY[player.difficulty] || DIFFICULTY.normal;
  const threshold = (game.biddingRound === 1 ? 92 : 86) / profile.trump;
  return score > threshold ? suit : null;
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

async function runCpu() {
  const game = state.game;
  if (!game || state.screen !== "table") return;
  if (game.phase === "trump") {
    const player = game.players[game.currentBidder];
    if (player.cpu) {
      const suit = cpuTrumpDecision(player);
      suit ? setTrump(game.currentBidder, suit, game.biddingRound === 1) : advanceTrumpBid();
      await persistGameState();
    }
    return;
  }
  if (game.phase === "bidding") {
    const player = game.players[game.current];
    if (player?.cpu) {
      player.bid = cpuBid(player);
      logLine(`${player.name} bids ${player.bid}.`);
      advanceSpadesBid(game);
      render();
      await persistGameState();
    }
    return;
  }
  if (game.phase !== "playing") return;
  const player = game.players[game.current];
  if (!player?.cpu) return;
  const card = chooseCpuCard(player);
  if (card) await commitPlay(player, card.id);
}

function scheduleCpu() {
  clearTimeout(cpuTimer);
  const game = state.game;
  if (!game) return;
  const shouldAct = isGameAuthority() && (
    (game.phase === "playing" && game.players[game.current]?.cpu) ||
    (game.phase === "bidding" && game.players[game.current]?.cpu) ||
    (game.phase === "trump" && game.players[game.currentBidder]?.cpu)
  );
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
  if (new Set(game.players.map(player => player.team)).size < game.players.length) {
    const leader = game.players.slice().sort((a, b) => b.total - a.total)[0];
    return `Team ${leader.team + 1}`;
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
      <div class="mark">LC</div>
      <div>
        <h1>Lunch Cards</h1>
        <p class="subtle">Hearts, Spades, Euchre</p>
      </div>
    </div>
    <div class="button-row">
      ${state.screen !== "setup" ? '<button class="btn" data-action="home">Home</button>' : ""}
      ${state.game ? '<button class="btn danger" data-action="new-lobby">Leave Table</button>' : ""}
    </div>
  </header><div class="toast-slot" role="status" aria-live="polite"></div>`;
}

function renderSetup() {
  const meta = GAMES[state.config.game];
  const sessions = getJoinableSessions(state.sessions);
  const selectedDifficulty = state.config.difficulties?.[state.config.game] || state.config.difficulty;
  const setupName = state.setupNameDraft || loadDisplayName();
  return `${renderTopbar()}
  <section class="screen setup-grid">
    <div class="panel">
      <div class="panel-title"><h2>Coworker Queue</h2><span class="pill connection-${state.connection}">${escapeHtml(state.connectionMessage)}</span></div>
      <div class="field-stack">
        <div class="field">
          <label for="playerName">Name</label>
          <input id="playerName" value="${escapeHtml(setupName)}" autocomplete="name" maxlength="24">
        </div>
        <div class="field">
          <label for="playerCount">Seats</label>
          <input id="playerCount" type="number" min="${meta.min}" max="${meta.max}" value="${state.config.game === "euchre" ? 4 : clamp(state.config.players, meta.min, meta.max)}" ${state.config.game === "euchre" ? "disabled" : ""}>
        </div>
        <div class="field">
          <label for="difficulty">${meta.title} CPU Difficulty</label>
          <select id="difficulty">${Object.entries(DIFFICULTY).map(([key, value]) => `<option value="${key}" ${key === selectedDifficulty ? "selected" : ""}>${value.label}</option>`).join("")}</select>
        </div>
        <div class="field">
          <label for="targetScore">Target Score</label>
          <input id="targetScore" type="number" min="5" max="500" value="${clamp(state.config.target, 5, 500)}">
        </div>
        <div class="field">
          <label for="joinCode">Join By Code</label>
          <input id="joinCode" inputmode="text" maxlength="8" placeholder="ABCDE" autocapitalize="characters">
        </div>
      </div>
      <div class="button-row">
        <button class="btn primary" data-action="play-solo">Play Solo</button>
        <button class="btn" data-action="create-lobby" ${state.busyAction ? "disabled" : ""}>${state.busyAction === "create" ? "Creating..." : "Create Session"}</button>
        <button class="btn" data-action="join-code" ${state.busyAction ? "disabled" : ""}>Join Code</button>
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
        </article>`).join("") : `<p class="subtle">${state.connection === "offline" ? "Multiplayer is unavailable right now. Solo play still works; retry when the connection returns." : "No active sessions yet. Create one and the table code will show here for everyone."}</p>`}
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
  const draftName = state.lobbyNameDraft || seat?.name || loadDisplayName();
  const readyToLaunch = canLaunchSession({ player_count: lobby.config.players, players: lobby.seats });
  const readyCount = lobby.seats.filter(player => player.is_ready).length;
  return `${renderTopbar()}
  <section class="screen lobby-grid">
    <div class="panel">
      <div class="panel-title"><h2>${meta.title} Session</h2><span class="pill connection-${state.connection}">${escapeHtml(state.connectionMessage)}</span></div>
      <div class="roster-summary"><strong>${lobby.seats.length}/${lobby.config.players} seated</strong><span>${readyCount}/${lobby.config.players} ready</span><span>${lobby.status === "playing" ? "In progress" : "Waiting to launch"}</span></div>
      <div class="hub-code">
        <div><span class="label">Code</span><strong>${escapeHtml(lobby.code)}</strong></div>
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
          <input id="lobbyPlayerName" value="${escapeHtml(draftName)}" autocomplete="name" maxlength="24">
        </div>
        <div class="button-row">
          <button class="btn" data-action="save-player-name">Save Name</button>
          ${!seat && lobby.status === "lobby" ? '<button class="btn primary" data-action="join-current-session">Join Session</button>' : ""}
        </div>
      </div>
      <div class="button-row">
        ${seat && !seat.is_host && lobby.status !== "playing" ? `<button class="btn" data-action="toggle-ready">${seat.is_ready ? "Mark Not Ready" : "Ready Up"}</button>` : ""}
        ${host && lobby.status !== "playing" ? `<button class="btn primary" data-action="start-game" ${readyToLaunch ? "" : "disabled"}>Launch Table</button>` : ""}
        ${seat && lobby.status === "playing" ? '<button class="btn primary" data-action="start-game">Open Table</button>' : ""}
        <button class="btn" data-action="refresh-lobby">Refresh</button>
        <button class="btn danger" data-action="leave-session">${seat?.is_host ? "Close Session" : "Leave Session"}</button>
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
          <div class="field">
            <label for="hostDifficulty">CPU Difficulty</label>
            <select id="hostDifficulty">${Object.entries(DIFFICULTY).map(([key, value]) => `<option value="${key}" ${key === lobby.config.difficulty ? "selected" : ""}>${value.label}</option>`).join("")}</select>
          </div>
        </div>
        <div class="button-row">
          <button class="btn" data-action="save-host-settings">Save Setup</button>
          <button class="btn" data-action="fill-cpus">Fill CPUs</button>
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
            <p class="subtle">${occupant ? `${occupant.cpu ? `${DIFFICULTY[occupant.difficulty]?.label || "Normal"} CPU` : "Coworker"} · ${lobby.config.game === "hearts" ? "Individual" : `Team ${index % 2 + 1}`}` : "Waiting for a coworker or CPU."}</p>
          </article>`;
        }).join("")}
      </div>
    </div>
  </section>`;
}

function renderTable() {
  const game = state.game;
  const human = localPlayer(game) || game.players[0];
  const humanIndex = game.players.indexOf(human);
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
            <p class="subtle" aria-live="polite">${escapeHtml(game.message)}</p>
          </div>
          <div class="button-row">${renderPhaseButtons(game)}</div>
        </div>
        <div class="hand" tabindex="0" aria-label="Your hand">
          ${human.hand.map(card => {
            if (game.phase === "passing") return cardButton(card, { action: "select-pass", selected: state.selectedPass.has(card.id), disabled: Boolean(game.passSelections?.[String(humanIndex)]) });
            return cardButton(card, { disabled: !legalIds.has(card.id) || game.current !== humanIndex || game.phase !== "playing" });
          }).join("")}
        </div>
      </div>
    </div>
    <aside class="side-panel">
      <div class="panel">
        <div class="panel-title"><h2>Score</h2><span class="pill">${escapeHtml(winnerLabel())}</span></div>
        <div class="score-list">${renderScoreRows(game)}</div>
      </div>
      <div class="panel">
        <div class="panel-title"><h2>Table Log</h2></div>
        <div class="log" tabindex="0" aria-label="Table log" aria-live="polite">${game.log.map(item => `<div>${escapeHtml(item)}</div>`).join("") || '<div class="subtle">No plays yet.</div>'}</div>
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
    <div class="stat"><span>Turn</span><strong>${escapeHtml(game.players[game.current]?.name || "Table")}</strong></div>
    ${game.type === "euchre" ? `<div class="stat"><span>Trump</span><strong>${game.trump ? `${SUIT_SYMBOLS[game.trump]} ${game.trump}` : "Choosing"}</strong></div>` : `<div class="stat"><span>Trick</span><strong>${game.trickNumber}</strong></div>`}
    <div class="stat"><span>State</span><strong>${escapeHtml(phase)}</strong></div>
  </div>`;
}

function renderSeats(game) {
  const positions = SEAT_POSITIONS[game.players.length - 1] || SEAT_POSITIONS[3];
  const origin = Math.max(0, localPlayerIndex(game));
  return game.players.map((player, index) => {
    const visualIndex = (index - origin + game.players.length) % game.players.length;
    return `<div class="seat ${positions[visualIndex]} ${game.current === index ? "is-turn" : ""} ${index === origin ? "is-you" : ""}">
    <strong>${escapeHtml(player.name)}</strong>
    <div class="seat-meta"><span>${index === game.sittingOut ? "Sitting out" : `${player.hand.length} cards`}</span><span>${player.tricks} tricks</span></div>
    <div class="mini-cards">${Array.from({ length: Math.min(player.hand.length, 12) }, () => '<span class="mini-card"></span>').join("")}</div>
  </div>`;
  }).join("");
}

function renderTrick(game) {
  const display = game.trick.length ? game.trick : game.lastTrick?.plays || [];
  const winner = !game.trick.length ? game.lastTrick?.winner : null;
  return `<div class="trick-zone">
    ${display.map(play => `<div class="played-card ${winner === play.player ? "is-winner" : ""}">${cardButton(play.card, { disabled: true })}<small>${escapeHtml(game.players[play.player].name)}</small></div>`).join("")}
  </div>`;
}

function renderPhaseButtons(game) {
  if (game.phase === "passing") {
    const submitted = Boolean(game.passSelections?.[String(localPlayerIndex(game))]);
    return `<button class="btn primary" data-action="confirm-pass" ${state.selectedPass.size === 3 && !submitted ? "" : "disabled"}>${submitted ? "Pass Locked" : "Pass 3"}</button>`;
  }
  if (game.phase === "roundover") {
    return isGameAuthority() ? '<button class="btn primary" data-action="new-round">Next Round</button>' : '<span class="pill">Waiting for host</span>';
  }
  if (game.phase === "gameover") {
    return '<button class="btn primary" data-action="new-lobby">New Match</button>';
  }
  return "";
}

function renderScoreRows(game) {
  if (game.type !== "hearts" && new Set(game.players.map(player => player.team)).size < game.players.length) {
    return [...new Set(game.players.map(player => player.team))].map(team => {
      const players = game.players.filter(player => player.team === team);
      const active = players.some(player => game.players.indexOf(player) === game.current);
      const bags = game.type === "spades" ? ` · ${game.teamBags?.[team] || 0} bags` : "";
      return `<div class="score-row ${active ? "is-turn" : ""}"><div><strong>Team ${team + 1}</strong><p class="subtle">${players.map(player => escapeHtml(player.name)).join(" + ")}${bags}</p></div><strong>${players[0]?.total || 0}</strong></div>`;
    }).join("");
  }
  return game.players.map((player, index) => `<div class="score-row ${game.current === index ? "is-turn" : ""}">
    <div>
      <strong>${escapeHtml(player.name)}</strong>
      <p class="subtle">${scoreSubline(game, player)}</p>
    </div>
    <strong>${player.total}</strong>
  </div>`).join("");
}

function scoreSubline(game, player) {
  if (game.type === "hearts") return `${player.roundPoints} round points`;
  if (game.type === "spades") return `${player.tricks}/${player.bid ?? "-"} tricks · ${game.playerBags?.[game.players.indexOf(player)] || 0} bags`;
  return `Team ${player.team + 1} · ${player.tricks} tricks`;
}

function renderActionPanel(game) {
  const playerIndex = localPlayerIndex(game);
  const received = game.receivedCards?.[String(playerIndex)] || [];
  const receivedVersion = `${game.round}:${received.map(card => card.id).join(",")}`;
  if (received.length && state.reviewedReceivedVersion !== receivedVersion) {
    return `<div class="action-panel" role="dialog" aria-modal="true" aria-labelledby="receivedTitle">
      <div class="panel-title"><h2 id="receivedTitle">Cards Received</h2><span class="pill">${game.passDirection}</span></div>
      <div class="hand" tabindex="0" aria-label="Cards received">${received.map(card => cardButton(card, { disabled: true })).join("")}</div>
      <div class="button-row"><button class="btn primary" data-action="take-received">Place In Hand</button></div>
    </div>`;
  }
  if (game.phase === "bidding" && game.players[game.current]?.human) {
    const bidder = game.players[game.current];
    return `<div class="action-panel" role="dialog" aria-modal="true" aria-labelledby="bidTitle">
      <div class="panel-title"><h2 id="bidTitle">Your Bid</h2><span class="pill">${bidder.hand.length} cards</span></div>
      <div class="field"><label for="bidInput">Bid or choose 0 for Nil</label><input id="bidInput" type="number" min="0" max="${bidder.hand.length}" value="3"></div>
      <div class="button-row"><button class="btn primary" data-action="submit-bid">Lock Bid</button></div>
    </div>`;
  }
  if (game.phase === "trump" && game.players[game.currentBidder].human) {
    const choices = game.biddingRound === 1 ? [game.upcard.suit] : SUITS.filter(suit => suit !== game.upcard.suit);
    return `<div class="action-panel">
      <div class="panel-title"><h2>Trump</h2><span class="pill">Upcard ${game.upcard.rank}${SUIT_SYMBOLS[game.upcard.suit]}</span></div>
      <div class="button-row">
        ${choices.map(suit => `<button class="btn primary" data-action="trump-order" data-suit="${suit}">${SUIT_SYMBOLS[suit]} ${suit}</button>`).join("")}
        ${choices.map(suit => `<button class="btn" data-action="trump-alone" data-suit="${suit}">Go Alone · ${SUIT_SYMBOLS[suit]}</button>`).join("")}
        <button class="btn" data-action="trump-pass">Pass</button>
      </div>
    </div>`;
  }
  return "";
}

function toast(message) {
  state.toast = message;
  const slot = document.querySelector(".toast-slot") || app;
  let element = slot.querySelector(".toast");
  if (!element) {
    slot.insertAdjacentHTML("beforeend", '<div class="toast"></div>');
    element = slot.querySelector(".toast");
  }
  element.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (state.toast === message) {
      state.toast = "";
      document.querySelector(".toast-slot .toast")?.remove();
    }
  }, 2200);
}

async function getSupabaseClient() {
  const config = window.LUNCH_CARDS_SUPABASE || window.TABLE_CARDS_SUPABASE;
  if (!config?.url || !config?.publishableKey) return null;
  if (!supabaseClientPromise) {
    supabaseClientPromise = import("./supabase-client.js")
      .then(module => module.createClient(config.url, config.publishableKey));
  }
  return supabaseClientPromise;
}

async function syncLobbyToSupabase(lobby) {
  const supabase = await getSupabaseClient();
  if (!supabase) return false;
  try {
    const token = getSeatToken(lobby.code, true);
    const { data, error } = await supabase.rpc("table_cards_create_lobby", {
      p_code: lobby.code,
      p_game: lobby.config.game,
      p_target: lobby.config.target,
      p_player_count: lobby.config.players,
      p_difficulty: lobby.config.difficulty,
      p_host_name: lobby.config.playerName,
      p_client_id: state.clientId,
      p_token: token
    });
    if (error) throw error;
    lobby.backendId = data?.lobby_id;
    setConnection("online", "Multiplayer connected");
    return true;
  } catch (error) {
    console.warn("Supabase lobby sync failed", error);
    setConnection("offline", "Multiplayer unavailable");
    clearSeatToken(lobby.code);
    toast(error.message || "Could not create session");
    return false;
  }
}

async function loadLobbyFromSupabase(code) {
  const supabase = await getSupabaseClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("table_cards_get_lobby", {
    p_code: code,
    p_token: getSeatToken(code) || null
  });
  if (error) {
    setConnection("offline", "Multiplayer unavailable");
    return null;
  }
  if (!data?.lobby) return null;
  setConnection("online", "Multiplayer connected");
  return mapRemoteLobby(data.lobby, data.players || []);
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
    gameState: lobby.game_state,
    gameVersion: Number(lobby.game_version || 0),
    expiresAt: lobby.expires_at,
    players,
    config: {
      game: lobby.game,
      players: lobby.player_count,
      difficulty: lobby.difficulty || "normal",
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
  let supabase;
  try {
    supabase = await getSupabaseClient();
  } catch (error) {
    setConnection("offline", "Multiplayer unavailable");
    state.queueLoading = false;
    return;
  }
  if (!supabase) return;
  state.queueLoading = true;
  const { data: lobbies, error } = await supabase
    .from("table_cards_lobbies")
    .select("id, code, game, target_score, player_count, difficulty, host_name, status, game_version, expires_at, created_at, updated_at")
    .in("status", ["lobby", "playing"])
    .order("updated_at", { ascending: false })
    .limit(20);
  if (error) {
    state.queueLoading = false;
    setConnection("offline", "Multiplayer unavailable");
    toast("Could not load multiplayer sessions");
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
  setConnection("online", "Multiplayer connected");
  state.queueLoading = false;
  if (state.screen === "setup" && !isEditingSetupName()) render();
}

async function refreshLobby(code = state.lobby?.code) {
  if (!code) return null;
  const wasEditingName = isEditingLobbyName();
  const lobby = await loadLobbyFromSupabase(code);
  if (!lobby) {
    if (state.connection === "online" && state.lobby?.code === code) {
      const closedCode = state.lobby.code;
      state.lobby = null;
      state.game = null;
      state.screen = "setup";
      clearSeatToken(closedCode);
      void unsubscribeFromLobby();
      history.replaceState({}, "", new URL(window.location.pathname, window.location.origin).href);
      render();
      toast("Session closed or expired");
    }
    return null;
  }
  state.lobby = lobby;
  state.config = { ...state.config, ...lobby.config };
  if (["playing", "complete"].includes(lobby.status) && lobby.gameState && currentSeat(lobby)) {
    if (!state.game || lobby.gameVersion > state.gameVersion) {
      hydrateSharedGame(lobby.gameState, lobby.gameVersion);
      render();
      if (isHost() && state.game.phase === "passing") void maybeFinalizeSharedPasses();
    }
    return lobby;
  }
  if (state.screen === "lobby" && !wasEditingName && !isEditingLobbyName()) render();
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
  state.lobbyNameDraft = playerName;
  const lobby = await loadLobbyFromSupabase(code);
  if (!lobby) {
    toast("Session not found");
    return;
  }
  state.lobby = lobby;
  state.screen = "lobby";
  updateUrlLobby(lobby.code);
  if (currentSeat(lobby)) {
    subscribeToLobby(lobby.code);
    if (["playing", "complete"].includes(lobby.status) && lobby.gameState) {
      hydrateSharedGame(lobby.gameState, lobby.gameVersion);
    }
    render();
    return;
  }
  if (lobby.status !== "lobby") {
    toast("That game is already in progress");
    render();
    return;
  }
  const supabase = await getSupabaseClient();
  const token = getSeatToken(lobby.code, true);
  const { error } = await supabase.rpc("table_cards_join_lobby", {
    p_code: lobby.code,
    p_name: playerName,
    p_client_id: state.clientId,
    p_token: token
  });
  if (error) {
    clearSeatToken(lobby.code);
    toast(error.message || "Could not join session");
    await refreshLobby(lobby.code);
    return;
  }
  state.lobbyNameDraft = "";
  await refreshLobby(lobby.code);
  subscribeToLobby(lobby.code);
  toast(`Joined as ${playerName}`);
  await refreshSessions();
}

async function toggleReady() {
  const seat = currentSeat();
  if (!seat) return;
  const supabase = await getSupabaseClient();
  const { error } = await supabase.rpc("table_cards_update_player", {
    p_code: state.lobby.code,
    p_token: getSeatToken(state.lobby.code),
    p_name: null,
    p_ready: !seat.is_ready
  });
  if (error) return toast(error.message || "Could not update ready state");
  await refreshLobby();
}

async function savePlayerName() {
  const nextName = saveDisplayName(document.querySelector("#lobbyPlayerName")?.value || loadDisplayName());
  state.lobbyNameDraft = nextName;
  const seat = currentSeat();
  if (!seat) {
    toast("Name saved");
    render();
    return;
  }
  seat.name = nextName;
  state.lobbyNameDraft = "";
  const gamePlayer = localPlayer();
  if (gamePlayer) gamePlayer.name = nextName;
  render();
  const supabase = await getSupabaseClient();
  const { error } = await supabase.rpc("table_cards_update_player", {
    p_code: state.lobby.code,
    p_token: getSeatToken(state.lobby.code),
    p_name: nextName,
    p_ready: null
  });
  if (error) return toast(error.message || "Could not update name");
  await refreshLobby();
  toast("Name updated");
}

async function leaveLobby() {
  const seat = currentSeat();
  const supabase = await getSupabaseClient();
  if (seat) {
    const { error } = await supabase.rpc("table_cards_leave_lobby", {
      p_code: state.lobby.code,
      p_token: getSeatToken(state.lobby.code)
    });
    if (error) return toast(error.message || "Could not leave session");
  }
  clearSeatToken(state.lobby?.code);
  unsubscribeFromLobby();
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
  const difficulty = document.querySelector("#hostDifficulty")?.value || state.lobby.config.difficulty;
  const supabase = await getSupabaseClient();
  const { error } = await supabase.rpc("table_cards_update_lobby", {
    p_code: state.lobby.code,
    p_token: getSeatToken(state.lobby.code),
    p_game: game,
    p_target: clamp(target, 5, 500),
    p_player_count: count,
    p_difficulty: difficulty
  });
  if (error) return toast(error.message || "Could not update session");
  await refreshLobby();
  await refreshSessions();
  toast("Session updated");
}

async function fillCpuSeats() {
  if (!isHost()) return;
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.rpc("table_cards_fill_cpus", {
    p_code: state.lobby.code,
    p_token: getSeatToken(state.lobby.code)
  });
  if (error) return toast(error.message || "Could not fill CPU seats");
  await refreshLobby();
  await refreshSessions();
  toast(data ? `Added ${data} CPU player${data === 1 ? "" : "s"}` : "All seats are filled");
}

async function launchLobby() {
  const lobby = await refreshLobby() || state.lobby;
  if (["playing", "complete"].includes(lobby?.status) && lobby.gameState && currentSeat(lobby)) {
    hydrateSharedGame(lobby.gameState, lobby.gameVersion);
    render();
    return;
  }
  if (!isHost()) return;
  if (!canLaunchSession({ player_count: lobby.config.players, players: lobby.seats })) {
    toast("Fill every seat and ask everyone to ready up");
    return;
  }
  createGameFromLobby({ renderNow: false });
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.rpc("table_cards_start_game", {
    p_code: lobby.code,
    p_token: getSeatToken(lobby.code),
    p_state: serializeGame()
  });
  if (error) {
    state.game = null;
    state.screen = "lobby";
    render();
    return toast(error.message || "Could not launch table");
  }
  state.gameVersion = Number(data || 1);
  state.lobby.status = "playing";
  render();
  await refreshSessions();
}

async function persistGameState() {
  if (!state.game || !isSharedGame()) return true;
  if (state.gameSyncing) return false;
  const supabase = await getSupabaseClient();
  state.gameSyncing = true;
  const { data, error } = await supabase.rpc("table_cards_update_game", {
    p_code: state.lobby.code,
    p_token: getSeatToken(state.lobby.code),
    p_expected_version: state.gameVersion,
    p_state: serializeGame()
  });
  state.gameSyncing = false;
  if (error || Number(data) < 0) {
    toast(Number(data) < 0 ? "Table updated; syncing your view" : error.message || "Could not sync play");
    await refreshLobby();
    return false;
  }
  state.gameVersion = Number(data);
  setConnection("online", "Table synchronized");
  return true;
}

async function maybeFinalizeSharedPasses() {
  if (!state.game || state.game.phase !== "passing" || !isGameAuthority()) return;
  fillCpuPassSelections(state.game);
  if (!allPassesReady(state.game)) return;
  applyHeartsPasses(state.game);
  render();
  await persistGameState();
}

async function heartbeat() {
  if (!state.lobby?.backendId || !currentSeat()) return;
  const supabase = await getSupabaseClient();
  const { error } = await supabase.rpc("table_cards_heartbeat", {
    p_code: state.lobby.code,
    p_token: getSeatToken(state.lobby.code)
  });
  if (error) setConnection("offline", "Reconnecting to table");
}

async function subscribeToLobby(code) {
  if (realtimeChannel && realtimeCode === code) return;
  const supabase = await getSupabaseClient();
  await unsubscribeFromLobby();
  realtimeChannel = supabase.channel(`lunch-cards-${code}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "table_cards_lobbies", filter: `code=eq.${code}` }, () => void refreshLobby(code))
    .on("postgres_changes", { event: "*", schema: "public", table: "table_cards_players" }, payload => {
      if (!state.lobby?.backendId || (payload.new?.lobby_id !== state.lobby.backendId && payload.old?.lobby_id !== state.lobby.backendId)) return;
      void refreshLobby(code);
    })
    .subscribe(status => {
      if (status === "SUBSCRIBED") setConnection("online", "Live table connected");
      if (["CHANNEL_ERROR", "TIMED_OUT"].includes(status)) setConnection("offline", "Reconnecting to table");
    });
  realtimeCode = code;
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => void heartbeat(), 30000);
}

async function unsubscribeFromLobby() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  const channel = realtimeChannel;
  realtimeChannel = null;
  realtimeCode = "";
  if (channel) {
    const client = await getSupabaseClient();
    await client?.removeChannel(channel);
  }
}

function render() {
  if (state.screen === "setup") app.innerHTML = renderSetup();
  if (state.screen === "lobby") app.innerHTML = renderLobby();
  if (state.screen === "table") app.innerHTML = renderTable();
  if (state.toast) {
    const slot = document.querySelector(".toast-slot");
    if (slot) slot.innerHTML = `<div class="toast">${escapeHtml(state.toast)}</div>`;
  }
  scheduleCpu();
  scheduleQueueRefresh();
}

function scheduleQueueRefresh() {
  clearInterval(queueTimer);
  if (state.screen === "setup") {
    queueTimer = setInterval(() => {
      if (!document.hidden) void refreshSessions();
    }, 15000);
  }
  if (state.screen === "lobby" || (state.screen === "table" && isSharedGame())) {
    queueTimer = setInterval(() => {
      if (!document.hidden) void refreshLobby();
    }, 5000);
  }
}

app.addEventListener("click", event => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  if (action === "home") {
    if (state.screen === "lobby" && currentSeat()) {
      void leaveLobby();
      return;
    }
    unsubscribeFromLobby();
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
    captureSetupDraft();
    const game = target.dataset.game;
    state.config.game = game;
    state.config.difficulty = state.config.difficulties?.[game] || state.config.difficulty;
    state.config.target = GAMES[game].target;
    state.config.players = GAMES[game].defaultPlayers;
    render();
  }
  if (action === "play-solo") createSoloGame();
  if (action === "create-lobby") void createLobby();
  if (action === "refresh-sessions") void refreshSessions();
  if (action === "join-session") void joinLobby(target.dataset.code);
  if (action === "join-code") {
    const code = document.querySelector("#joinCode")?.value.trim().toUpperCase();
    if (code) void joinLobby(code);
    else toast("Enter a session code");
  }
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
  if (action === "confirm-pass") void confirmHeartsPass();
  if (action === "take-received") {
    const received = state.game.receivedCards?.[String(localPlayerIndex())] || [];
    state.reviewedReceivedVersion = `${state.game.round}:${received.map(card => card.id).join(",")}`;
    state.pendingReceived = [];
    render();
  }
  if (action === "play-card") void playCard(target.dataset.card);
  if (action === "submit-bid") void submitBid();
  if (action === "trump-order") void trumpAction("order", target.dataset.suit);
  if (action === "trump-alone") void trumpAction("alone", target.dataset.suit);
  if (action === "trump-pass") void trumpAction("pass");
  if (action === "new-round" && isGameAuthority()) {
    startRound();
    void persistGameState();
  }
});

app.addEventListener("change", event => {
  if (event.target.id !== "difficulty") return;
  captureSetupDraft();
  state.config.difficulty = event.target.value;
  state.config.difficulties = { ...state.config.difficulties, [state.config.game]: event.target.value };
  render();
});

app.addEventListener("input", event => {
  if (event.target.id === "playerName") state.setupNameDraft = event.target.value;
  if (event.target.id === "lobbyPlayerName") state.lobbyNameDraft = event.target.value;
  if (event.target.id === "playerCount") state.config.players = Number(event.target.value);
  if (event.target.id === "targetScore") state.config.target = Number(event.target.value);
});

async function bootFromUrl() {
  state.config.playerName = loadDisplayName();
  state.setupNameDraft = state.config.playerName;
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
    if (["playing", "complete"].includes(remoteLobby.status) && remoteLobby.gameState && currentSeat(remoteLobby)) {
      hydrateSharedGame(remoteLobby.gameState, remoteLobby.gameVersion);
    } else {
      state.screen = "lobby";
    }
    subscribeToLobby(remoteLobby.code);
    render();
    return;
  }
  state.screen = "setup";
  history.replaceState({}, "", new URL(window.location.pathname, window.location.origin).href);
  render();
  toast(state.connection === "offline" ? "Multiplayer is unavailable" : "Session not found or expired");
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => undefined));
}

void bootFromUrl();
render();
