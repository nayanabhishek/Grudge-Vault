export const FACTIONS = ["ember", "tide", "thorn", "void"] as const;
export type Faction = (typeof FACTIONS)[number];
export const HEX_TYPES = ["rot", "jinx", "shackle", "envy"] as const;
export type HexType = (typeof HEX_TYPES)[number];

export const CARD_CATALOG = [
  { id: "ember-spark", type: "relic", faction: "ember", name: "Spark" },
  { id: "ember-cinder", type: "relic", faction: "ember", name: "Cinder" },
  { id: "ember-flare", type: "relic", faction: "ember", name: "Flare" },
  { id: "ember-brand", type: "relic", faction: "ember", name: "Brand" },
  { id: "ember-sunforge", type: "relic", faction: "ember", name: "Sunforge" },
  { id: "tide-drip", type: "relic", faction: "tide", name: "Drip" },
  { id: "tide-ripple", type: "relic", faction: "tide", name: "Ripple" },
  { id: "tide-current", type: "relic", faction: "tide", name: "Current" },
  { id: "tide-tempest", type: "relic", faction: "tide", name: "Tempest" },
  { id: "tide-leviathan-tear", type: "relic", faction: "tide", name: "Leviathan Tear" },
  { id: "thorn-seedling", type: "relic", faction: "thorn", name: "Seedling" },
  { id: "thorn-bramble", type: "relic", faction: "thorn", name: "Bramble" },
  { id: "thorn-vine", type: "relic", faction: "thorn", name: "Vine" },
  { id: "thorn-briar", type: "relic", faction: "thorn", name: "Briar" },
  { id: "thorn-elder-root", type: "relic", faction: "thorn", name: "Elder Root" },
  { id: "void-whisper", type: "relic", faction: "void", name: "Whisper" },
  { id: "void-gloom", type: "relic", faction: "void", name: "Gloom" },
  { id: "void-shade", type: "relic", faction: "void", name: "Shade" },
  { id: "void-rift", type: "relic", faction: "void", name: "Rift" },
  { id: "void-maw", type: "relic", faction: "void", name: "Maw" },
  { id: "hex-rot", type: "hex", hex: "rot", name: "Rot" },
  { id: "hex-jinx", type: "hex", hex: "jinx", name: "Jinx" },
  { id: "hex-shackle", type: "hex", hex: "shackle", name: "Shackle" },
  { id: "hex-envy", type: "hex", hex: "envy", name: "Envy" },
] as const;

export type Card = (typeof CARD_CATALOG)[number];
export type CardId = Card["id"];
export type RelicCard = Extract<Card, { type: "relic" }>;
export type HexCard = Extract<Card, { type: "hex" }>;
export type PlayerId = string;
export type MatchId = string;
export type GameStatus = "active" | "paused" | "complete" | "abandoned";
const CARD_BY_ID = new Map<CardId, Card>(CARD_CATALOG.map((card) => [card.id, card]));

export function getCard(cardId: CardId): Card {
  const card = CARD_BY_ID.get(cardId);
  if (!card) throw new Error(`Unknown card id: ${cardId}`);
  return card;
}

export interface PlayerSetup { id: PlayerId; displayName: string; mark: Faction }
export interface PlayerState extends PlayerSetup { heldRelicIds: CardId[]; heldHexIds: CardId[] }
export interface GameState {
  matchId: MatchId;
  revision: number;
  status: GameStatus;
  players: PlayerState[];
  turnOrder: PlayerId[];
  currentPlayerId: PlayerId | null;
  /** Server-only ordered cards not yet revealed. */
  deck: CardId[];
  vault: CardId[];
}

export interface InitialStateOptions {
  matchId: MatchId;
  players: readonly PlayerSetup[];
  /** Full shuffled permutation, useful for deterministic tests and server-controlled randomness. */
  shuffledDeck?: readonly CardId[];
  /** Injected random source used only when shuffledDeck is omitted. Must return values in [0, 1). */
  random?: () => number;
}

export interface TakeCardAction {
  type: "take_card";
  playerId: PlayerId;
  cardId: CardId;
  /** Required for a Hex card; forbidden for relics. */
  recipientPlayerId?: PlayerId;
}

export type ActionErrorCode =
  | "game_not_active" | "not_active_player" | "card_not_in_vault"
  | "hex_recipient_required" | "invalid_hex_recipient" | "unexpected_hex_recipient";
export interface ActionError { code: ActionErrorCode; message: string }
export type ActionValidation = { valid: true } | { valid: false; error: ActionError };
export type ApplyActionResult =
  | { ok: true; state: GameState }
  | { ok: false; state: GameState; error: ActionError };

function assertValidPlayers(players: readonly PlayerSetup[]): void {
  if (players.length < 2 || players.length > 4) throw new Error("A match requires 2 to 4 players");
  const ids = new Set<string>();
  for (const player of players) {
    if (!player.id.trim()) throw new Error("Player ids must be non-empty");
    if (ids.has(player.id)) throw new Error(`Duplicate player id: ${player.id}`);
    if (!FACTIONS.includes(player.mark)) throw new Error(`Invalid Mark for player ${player.id}`);
    ids.add(player.id);
  }
}

function assertDeck(deck: readonly CardId[]): void {
  if (deck.length !== CARD_CATALOG.length) throw new Error("A shuffled deck must contain exactly 24 cards");
  const ids = new Set(deck);
  if (ids.size !== CARD_CATALOG.length || CARD_CATALOG.some((card) => !ids.has(card.id))) {
    throw new Error("A shuffled deck must contain every unique card exactly once");
  }
}

function shuffledCardIds(random: () => number): CardId[] {
  const cards = CARD_CATALOG.map((card) => card.id);
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError("Random source must return a value in [0, 1)");
    const other = Math.floor(value * (index + 1));
    [cards[index], cards[other]] = [cards[other]!, cards[index]!];
  }
  return cards;
}

export function createInitialState(options: InitialStateOptions): GameState {
  assertValidPlayers(options.players);
  const allCards = options.shuffledDeck
    ? [...options.shuffledDeck]
    : shuffledCardIds(options.random ?? Math.random);
  assertDeck(allCards);
  const players = options.players.map((player) => ({ ...player, heldRelicIds: [], heldHexIds: [] }));
  return {
    matchId: options.matchId,
    revision: 0,
    status: "active",
    players,
    turnOrder: players.map(({ id }) => id),
    currentPlayerId: players[0]!.id,
    vault: allCards.slice(0, 5),
    deck: allCards.slice(5),
  };
}

export function validateAction(state: GameState, action: TakeCardAction): ActionValidation {
  if (state.status !== "active") return { valid: false, error: { code: "game_not_active", message: "The match is not active." } };
  if (action.playerId !== state.currentPlayerId) return { valid: false, error: { code: "not_active_player", message: "Only the active player may take a card." } };
  if (!state.vault.includes(action.cardId)) return { valid: false, error: { code: "card_not_in_vault", message: "That card is not in the Vault." } };
  const card = getCard(action.cardId);
  if (card.type === "hex") {
    if (!action.recipientPlayerId) return { valid: false, error: { code: "hex_recipient_required", message: "Choose an opponent to receive the Hex." } };
    if (action.recipientPlayerId === action.playerId || !state.players.some(({ id }) => id === action.recipientPlayerId)) {
      return { valid: false, error: { code: "invalid_hex_recipient", message: "A Hex must go to another player in this match." } };
    }
  } else if (action.recipientPlayerId !== undefined) {
    return { valid: false, error: { code: "unexpected_hex_recipient", message: "Relic picks cannot have a Hex recipient." } };
  }
  return { valid: true };
}

export function applyAction(state: GameState, action: TakeCardAction): ApplyActionResult {
  const validation = validateAction(state, action);
  if (!validation.valid) return { ok: false, state, error: validation.error };

  const card = getCard(action.cardId);
  const players = state.players.map((player) => {
    if (card.type === "relic" && player.id === action.playerId) {
      return { ...player, heldRelicIds: [...player.heldRelicIds, card.id] };
    }
    if (card.type === "hex" && player.id === action.recipientPlayerId) {
      return { ...player, heldHexIds: [...player.heldHexIds, card.id] };
    }
    return player;
  });
  const deck = [...state.deck];
  const vault = state.vault.filter((cardId) => cardId !== action.cardId);
  while (vault.length < 5 && deck.length > 0) vault.push(deck.shift()!);

  const complete = vault.length === 0 && deck.length === 0;
  const nextIndex = (state.turnOrder.indexOf(action.playerId) + 1) % state.turnOrder.length;
  return {
    ok: true,
    state: {
      ...state,
      revision: state.revision + 1,
      status: complete ? "complete" : "active",
      players,
      deck,
      vault,
      currentPlayerId: complete ? null : state.turnOrder[nextIndex]!,
    },
  };
}

export type FactionScores = Record<Faction, number>;
export interface PlayerScore {
  playerId: PlayerId;
  mark: Faction;
  factionScores: FactionScores;
  markBonus: number;
  hexPenalty: number;
  total: number;
}
export interface GameResult { matchId: MatchId; scores: PlayerScore[]; winnerPlayerIds: PlayerId[] }
const TRIANGULAR_SCORE = [0, 1, 3, 6, 10, 15] as const;

export function scoreFaction(relicCount: number): number {
  if (!Number.isInteger(relicCount) || relicCount < 0 || relicCount > 5) throw new RangeError("Faction relic count must be an integer from 0 to 5");
  return TRIANGULAR_SCORE[relicCount]!;
}

export function calculatePlayerScore(player: PlayerState): PlayerScore {
  const counts: Record<Faction, number> = { ember: 0, tide: 0, thorn: 0, void: 0 };
  for (const cardId of player.heldRelicIds) {
    const card = getCard(cardId);
    if (card.type !== "relic") throw new Error(`Hex ${cardId} found in relic collection`);
    counts[card.faction] += 1;
  }
  const factionScores: FactionScores = {
    ember: scoreFaction(counts.ember), tide: scoreFaction(counts.tide),
    thorn: scoreFaction(counts.thorn), void: scoreFaction(counts.void),
  };
  const markBonus = counts[player.mark] >= 3 ? 3 : 0;
  const hexPenalty = player.heldHexIds.length * 3;
  return {
    playerId: player.id,
    mark: player.mark,
    factionScores,
    markBonus,
    hexPenalty,
    total: Object.values(factionScores).reduce((sum, points) => sum + points, 0) + markBonus - hexPenalty,
  };
}

export function calculateScores(state: GameState): PlayerScore[] {
  return state.players.map(calculatePlayerScore);
}

export function isGameComplete(state: GameState): boolean {
  return state.status === "complete" && state.deck.length === 0 && state.vault.length === 0;
}

export function getGameResult(state: GameState): GameResult | null {
  if (!isGameComplete(state)) return null;
  const scores = calculateScores(state);
  const highScore = Math.max(...scores.map(({ total }) => total));
  return { matchId: state.matchId, scores, winnerPlayerIds: scores.filter(({ total }) => total === highScore).map(({ playerId }) => playerId) };
}

export type LifecycleResult = { ok: true; state: GameState } | { ok: false; state: GameState; error: ActionError };
export function pauseMatch(state: GameState): LifecycleResult {
  if (state.status !== "active") return { ok: false, state, error: { code: "game_not_active", message: "Only an active match can be paused." } };
  return { ok: true, state: { ...state, status: "paused", revision: state.revision + 1 } };
}
export function resumeMatch(state: GameState): LifecycleResult {
  if (state.status !== "paused") return { ok: false, state, error: { code: "game_not_active", message: "Only a paused match can resume." } };
  return { ok: true, state: { ...state, status: "active", revision: state.revision + 1 } };
}
export function abandonMatch(state: GameState): LifecycleResult {
  if (state.status !== "paused") return { ok: false, state, error: { code: "game_not_active", message: "Only a paused match can be abandoned." } };
  return { ok: true, state: { ...state, status: "abandoned", currentPlayerId: null, revision: state.revision + 1 } };
}

export interface PublicPlayer {
  id: PlayerId;
  displayName: string;
  heldRelicIds: CardId[];
  heldHexIds: CardId[];
  /** Null for opponents until match completion. */
  mark: Faction | null;
}
export interface PlayerPublicState {
  matchId: MatchId;
  revision: number;
  status: GameStatus;
  players: PublicPlayer[];
  turnOrder: PlayerId[];
  currentPlayerId: PlayerId | null;
  vault: CardId[];
  you: { playerId: PlayerId; mark: Faction };
  result: GameResult | null;
}

/** Explicit allowlist projection. Never serialize GameState to a player socket. */
export function projectForPlayer(state: GameState, playerId: PlayerId): PlayerPublicState {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error("Player is not in this match");
  const revealMarks = state.status === "complete";
  return {
    matchId: state.matchId,
    revision: state.revision,
    status: state.status,
    players: state.players.map(({ id, displayName, heldRelicIds, heldHexIds, mark }) => ({
      id, displayName, heldRelicIds: [...heldRelicIds], heldHexIds: [...heldHexIds], mark: revealMarks ? mark : null,
    })),
    turnOrder: [...state.turnOrder],
    currentPlayerId: state.currentPlayerId,
    vault: [...state.vault],
    you: { playerId: player.id, mark: player.mark },
    result: getGameResult(state),
  };
}

export interface RequestMeta {
  requestId: string;
}

export interface RoomPublicPlayer {
  id: PlayerId;
  displayName: string;
  seatNo: number;
  connected: boolean;
  markSelected: boolean;
}
export interface RoomPublicState {
  roomId: string;
  status: "lobby" | GameStatus;
  hostPlayerId: PlayerId;
  players: RoomPublicPlayer[];
  capacity: 4;
  matchId: MatchId | null;
}
export interface PlayerSessionSnapshot {
  room: RoomPublicState;
  game: PlayerPublicState | null;
}

export interface ClientToServerEvents {
  "room:create": (payload: RequestMeta & { displayName: string }, ack: Ack<RoomCreated>) => void;
  "room:join": (payload: RequestMeta & { roomCode: string; displayName: string }, ack: Ack<RoomJoined>) => void;
  "room:state": (payload: RequestMeta & { roomId: string }, ack: Ack<RoomPublicState>) => void;
  "room:leave": (payload: RequestMeta & { roomId: string }, ack: Ack<{ left: true }>) => void;
  "match:choose-mark": (payload: RequestMeta & { roomId: string; mark: Faction }, ack: Ack<{}>) => void;
  "match:start": (payload: RequestMeta & { roomId: string }, ack: Ack<{ matchId: MatchId }>) => void;
  "game:take-card": (payload: RequestMeta & { matchId: MatchId; cardId: CardId; recipientPlayerId?: PlayerId }, ack: Ack<{ revision: number }>) => void;
  "match:reconnect": (payload: RequestMeta & { reconnectToken: string }, ack: Ack<PlayerSessionSnapshot>) => void;
  "match:sync": (payload: RequestMeta & { roomId: string }, ack: Ack<PlayerSessionSnapshot>) => void;
}

export interface ServerToClientEvents {
  "room:created": (payload: { roomId: string }) => void;
  "room:updated": (payload: RoomPublicState) => void;
  "match:started": (payload: { matchId: MatchId; revision: number }) => void;
  "game:state": (payload: { state: PlayerPublicState }) => void;
  "match:ended": (payload: { state: PlayerPublicState }) => void;
  "server:error": (payload: { requestId?: string; code: string; message: string }) => void;
}

export interface InterServerEvents {}
export interface SocketData { playerId?: PlayerId; roomId?: string; lastStateRevision?: number }

export interface Ack<T> {
  (result: { ok: true; requestId: string; data: T } | { ok: false; requestId: string; error: { code: string; message: string } }): void;
}

export interface RoomCreated { roomId: string; roomCode: string; playerId: PlayerId; reconnectToken: string }
export interface RoomJoined { roomId: string; playerId: PlayerId; reconnectToken: string }
