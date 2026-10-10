import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  FACTIONS,
  getCard,
  scoreFaction,
  type CardId,
  type ClientToServerEvents,
  type Faction,
  type PlayerPublicState,
  type RoomPublicState,
  type ServerToClientEvents,
} from '@grudge-vault/game-engine';

const SESSION_KEY = 'grudge-vault.session.v1';
const MARKS: Record<Faction, { name: string; icon: string; line: string }> = {
  ember: { name: 'Ember', icon: '✹', line: 'What survives the fire remembers.' },
  tide: { name: 'Tide', icon: '≈', line: 'Every debt returns with the current.' },
  thorn: { name: 'Thorn', icon: '⌘', line: 'Take care what you reach for.' },
  void: { name: 'Void', icon: '◉', line: 'Some things are best left unseen.' },
};

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type Session = { roomId: string; playerId: string; reconnectToken: string; roomCode?: string; displayName: string; mark?: Faction };
type Connection = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
type Screen = 'home' | 'lobby' | 'match';
type CommandName = keyof ClientToServerEvents;
type CommandPayload<E extends CommandName> = Parameters<ClientToServerEvents[E]>[0];
type CommandReply<E extends CommandName> = Parameters<Parameters<ClientToServerEvents[E]>[1]>[0];
type CommandData<E extends CommandName> = Extract<CommandReply<E>, { ok: true }>['data'];

const newRequestId = () => crypto.randomUUID();
const getStoredSession = (): Session | null => {
  try {
    const value = sessionStorage.getItem(SESSION_KEY);
    return value ? JSON.parse(value) as Session : null;
  } catch { return null; }
};
const factionName = (faction: Faction) => MARKS[faction].name;
const cardById = (id: CardId) => getCard(id);

function messageForCode(code: string, fallback: string): string {
  const messages: Record<string, string> = {
    ROOM_NOT_FOUND: 'That room code is not active. Check it and try again.',
    ROOM_FULL: 'This room already has four players.',
    ROOM_NOT_JOINABLE: 'That match has already started.',
    INVALID_ROOM_CODE: 'Room codes contain ten letters or numbers.',
    INVALID_DISPLAY_NAME: 'Choose a name from 1 to 24 characters.',
    NOT_HOST: 'Only the host can start this match.',
    NOT_ENOUGH_PLAYERS: 'Invite at least one more player before starting.',
    MARK_REQUIRED: 'Every player must choose a private Mark first.',
    MARK_LOCKED: 'Your Mark is already locked for this room.',
    OUT_OF_TURN: 'It is not your turn.',
    CARD_NOT_AVAILABLE: 'That card is no longer in the Vault. Syncing the table…',
    INVALID_HEX_TARGET: 'Choose an opponent to receive the Hex.',
    MATCH_NOT_ACTIVE: 'This match is paused or has ended.',
    UNAUTHORIZED: 'This seat is no longer connected to the room.',
  };
  return messages[code] ?? fallback;
}

export default function App() {
  const socket = useMemo(() => {
    const configured = import.meta.env.VITE_SERVER_URL?.trim();
    const origin = configured || window.location.origin;
    return io(`${origin}/game`, { autoConnect: false, reconnection: true, reconnectionAttempts: Infinity, timeout: 10_000 }) as GameSocket;
  }, []);
  const sessionRef = useRef<Session | null>(getStoredSession());
  const [connection, setConnection] = useState<Connection>('connecting');
  const [screen, setScreen] = useState<Screen>('home');
  const [room, setRoom] = useState<RoomPublicState | null>(null);
  const [game, setGame] = useState<PlayerPublicState | null>(null);
  const [name, setName] = useState(sessionRef.current?.displayName ?? '');
  const [roomCode, setRoomCode] = useState(sessionRef.current?.roomCode ?? '');
  const [mark, setMark] = useState<Faction | null>(sessionRef.current?.mark ?? null);
  const [pendingHex, setPendingHex] = useState<CardId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const persistSession = useCallback((value: Session | null) => {
    sessionRef.current = value;
    if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(SESSION_KEY);
  }, []);

  const command = useCallback(<E extends CommandName,>(event: E, payload: CommandPayload<E>): Promise<CommandReply<E>> => {
    return new Promise((resolve, reject) => {
      if (!socket.connected) { reject(new Error('The game server is not connected yet.')); return; }
      const timer = window.setTimeout(() => reject(new Error('The server did not reply. Check your connection and try again.')), 12_000);
      const typedSocket = socket as unknown as {
        emit<K extends E>(name: K, data: CommandPayload<K>, ack: (reply: CommandReply<K>) => void): void;
      };
      typedSocket.emit(event, payload, (reply) => {
        window.clearTimeout(timer);
        resolve(reply as CommandReply<E>);
      });
    });
  }, [socket]);

  const applySnapshot = useCallback((snapshotRoom: RoomPublicState, snapshotGame: PlayerPublicState | null) => {
    setRoom(snapshotRoom);
    setGame(snapshotGame);
    setScreen(snapshotGame ? 'match' : 'lobby');
    setPendingHex(null);
  }, []);

  const recoverSession = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) { setConnection('connected'); setScreen('home'); return; }
    setConnection('reconnecting');
    try {
      const result = await command('match:reconnect', { requestId: newRequestId(), reconnectToken: current.reconnectToken });
      if (!result.ok) throw new Error(messageForCode(result.error.code, result.error.message));
      const { room: restoredRoom, game: restoredGame } = result.data;
      if (restoredGame) setMark(restoredGame.you.mark);
      applySnapshot(restoredRoom, restoredGame);
      setConnection('connected');
      setError('');
      setNotice('Seat restored. Your Mark and place at the table are safe.');
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not restore this room session.';
      setConnection('connected');
      setError(`Reconnect failed: ${message}`);
      if (/credential|seat|expired|invalid/iu.test(message)) persistSession(null);
      setRoom(null);
      setGame(null);
      setScreen('home');
    }
  }, [applySnapshot, command, persistSession]);

  useEffect(() => {
    const onConnect = () => { void recoverSession(); };
    const onDisconnect = () => setConnection(sessionRef.current ? 'reconnecting' : 'disconnected');
    const onConnectError = () => setConnection(sessionRef.current ? 'reconnecting' : 'disconnected');
    const onRoomUpdate = (next: RoomPublicState) => {
      if (!sessionRef.current || sessionRef.current.roomId !== next.roomId) return;
      setRoom(next);
      if (next.status === 'active' || next.status === 'paused' || next.status === 'complete' || next.status === 'abandoned') setScreen('match');
      else setScreen('lobby');
    };
    const onGameState = (payload: { state: PlayerPublicState }) => {
      setGame((previous) => !previous || payload.state.revision >= previous.revision ? payload.state : previous);
      setScreen('match');
      setPendingHex(null);
    };
    const onMatchEnded = (payload: { state: PlayerPublicState }) => {
      setGame(payload.state);
      setScreen('match');
      setPendingHex(null);
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('room:updated', onRoomUpdate);
    socket.on('game:state', onGameState);
    socket.on('match:ended', onMatchEnded);
    socket.connect();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('room:updated', onRoomUpdate);
      socket.off('game:state', onGameState);
      socket.off('match:ended', onMatchEnded);
      socket.disconnect();
    };
  }, [socket, recoverSession]);

  const run = useCallback(async <E extends CommandName,>(event: E, payload: CommandPayload<E>): Promise<CommandData<E> | null> => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await command(event, payload);
      if (!result.ok) {
        setError(messageForCode(result.error.code, result.error.message));
        if (result.error.code === 'CARD_NOT_AVAILABLE') {
          const activeRoom = sessionRef.current?.roomId;
          if (activeRoom) {
            const sync = await command('match:sync', { requestId: newRequestId(), roomId: activeRoom });
            if (sync.ok) applySnapshot(sync.data.room, sync.data.game);
          }
        }
        return null;
      }
      return result.data as CommandData<E>;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The command could not be completed.');
      return null;
    } finally { setBusy(false); }
  }, [applySnapshot, command]);

  const createRoom = async (event: FormEvent) => {
    event.preventDefault();
    const created = await run('room:create', { requestId: newRequestId(), displayName: name });
    if (!created) return;
    const next: Session = { roomId: created.roomId, playerId: created.playerId, reconnectToken: created.reconnectToken, roomCode: created.roomCode, displayName: name.trim() };
    persistSession(next);
    setRoomCode(created.roomCode);
    setConnection('connected');
    const sync = await command('room:state', { requestId: newRequestId(), roomId: created.roomId }).catch(() => null);
    if (sync?.ok) { setRoom(sync.data); setScreen('lobby'); }
    setNotice('Private room created. Share the code with your players.');
  };

  const joinRoom = async (event: FormEvent) => {
    event.preventDefault();
    const joined = await run('room:join', { requestId: newRequestId(), roomCode, displayName: name });
    if (!joined) return;
    persistSession({ roomId: joined.roomId, playerId: joined.playerId, reconnectToken: joined.reconnectToken, roomCode: roomCode.trim().toUpperCase(), displayName: name.trim() });
    const sync = await command('room:state', { requestId: newRequestId(), roomId: joined.roomId }).catch(() => null);
    if (sync?.ok) { setRoom(sync.data); setScreen('lobby'); }
    setMark(null);
    setNotice('You joined the room. Choose your secret Mark when you are ready.');
  };

  const chooseMark = async (faction: Faction) => {
    const current = sessionRef.current;
    if (!current) return;
    const result = await run('match:choose-mark', { requestId: newRequestId(), roomId: current.roomId, mark: faction });
    if (!result) return;
    setMark(faction);
    persistSession({ ...current, mark: faction });
    setNotice(`Your ${factionName(faction)} Mark is locked and private.`);
  };

  const startMatch = async () => {
    const current = sessionRef.current;
    if (!current) return;
    const result = await run('match:start', { requestId: newRequestId(), roomId: current.roomId });
    if (!result) return;
    const snapshot = await command('match:sync', { requestId: newRequestId(), roomId: current.roomId }).catch(() => null);
    if (snapshot?.ok) applySnapshot(snapshot.data.room, snapshot.data.game);
  };

  const takeRelic = async (cardId: CardId) => {
    if (!game || !sessionRef.current) return;
    await run('game:take-card', { requestId: newRequestId(), matchId: game.matchId, cardId });
  };

  const pickCard = (cardId: CardId) => {
    const card = cardById(cardId);
    if (card.type === 'hex') setPendingHex(cardId);
    else void takeRelic(cardId);
  };

  const assignHex = async (recipientPlayerId: string) => {
    if (!game || !sessionRef.current || !pendingHex) return;
    const result = await run('game:take-card', {
      requestId: newRequestId(), matchId: game.matchId, cardId: pendingHex, recipientPlayerId,
    });
    if (result) setPendingHex(null);
  };

  const leaveToTitle = () => {
    const current = sessionRef.current;
    if (current && room?.status === 'lobby' && socket.connected) {
      void command('room:leave', { requestId: newRequestId(), roomId: current.roomId }).catch(() => {
        // The local seat is cleared below either way; a dropped connection may already have removed it.
      });
    } else if (current && socket.connected) {
      socket.disconnect();
      window.setTimeout(() => socket.connect(), 150);
    }
    persistSession(null);
    setRoom(null);
    setGame(null);
    setMark(null);
    setScreen('home');
    setNotice('This device has left its saved seat. The room remains available to its other players.');
  };

  const activeScreen: Screen = screen === 'home' && room ? (game ? 'match' : 'lobby') : screen;

  return (
    <main className="app-frame">
      <header className="topbar">
        <a className="wordmark" href="#home" onClick={(event) => event.preventDefault()} aria-label="Grudge Vault home">
          <span className="brand-mark">GV</span><span>GRUDGE <b>VAULT</b></span>
        </a>
        <div className={`connection-pill ${connection}`} role="status"><i />{connectionLabel(connection)}</div>
      </header>

      {error && <div className="toast error" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
      {notice && !error && <div className="toast notice" role="status"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss message">×</button></div>}

      {activeScreen === 'home' && (
        <HomeScreen
          name={name} setName={setName} roomCode={roomCode} setRoomCode={setRoomCode}
          connection={connection} busy={busy} onCreate={createRoom} onJoin={joinRoom}
        />
      )}
      {activeScreen === 'lobby' && room && (
        <LobbyScreen room={room} localPlayerId={sessionRef.current?.playerId ?? ''} mark={mark} busy={busy} onChooseMark={chooseMark} onStart={startMatch} onLeave={leaveToTitle} />
      )}
      {activeScreen === 'match' && game && room && (
        <MatchScreen
          game={game} room={room} localPlayerId={sessionRef.current?.playerId ?? ''} connection={connection} busy={busy}
          pendingHex={pendingHex} onPick={pickCard} onCancelHex={() => setPendingHex(null)} onAssignHex={assignHex} onLeave={leaveToTitle}
        />
      )}
      {activeScreen === 'match' && !game && room && (
        <section className="loading-panel" aria-live="polite"><span className="spinner" /><h1>Finding your place…</h1><p>Syncing the private table state.</p></section>
      )}
      {activeScreen === 'lobby' && !room && (
        <section className="loading-panel" aria-live="polite"><span className="spinner" /><h1>Restoring your room…</h1><p>Your seat and private Mark are being restored.</p></section>
      )}
      <footer className="site-footer"><span>BUILT FOR FRIENDS WITH LONG MEMORIES</span><span>SERVER-HELD SECRETS <b>✦</b></span></footer>
    </main>
  );
}

function HomeScreen(props: {
  name: string; setName: (value: string) => void; roomCode: string; setRoomCode: (value: string) => void;
  connection: Connection; busy: boolean; onCreate: (event: FormEvent) => void; onJoin: (event: FormEvent) => void;
}) {
  return (
    <>
      <section className="home-hero" id="home">
        <p className="eyebrow">A GAME OF RELICS &amp; RETRIBUTION</p>
        <h1>The Vault<br /><em>remembers.</em></h1>
        <p className="lede">Draft relics. Hide your Mark. Decide who carries the Hex.</p>
        <div className="home-card">
          <label className="field-label" htmlFor="player-name">YOUR NAME</label>
          <input id="player-name" autoComplete="nickname" maxLength={24} value={props.name} onChange={(event) => props.setName(event.target.value)} placeholder="A name for the ledger" />
          <button className="button primary full" type="button" disabled={!props.name.trim() || props.busy || props.connection !== 'connected'} onClick={(event) => props.onCreate(event as unknown as FormEvent)}>
            {props.busy ? 'Opening the Vault…' : 'Create a private room'} <span>↗</span>
          </button>
          <div className="or-rule"><span>OR ENTER A ROOM CODE</span></div>
          <form className="join-form" onSubmit={props.onJoin}>
            <label className="visually-hidden" htmlFor="room-code">Room code</label>
            <input id="room-code" value={props.roomCode} onChange={(event) => props.setRoomCode(event.target.value.toUpperCase().replace(/\s/gu, '').slice(0, 10))} placeholder="10-CHARACTER CODE" maxLength={10} autoComplete="off" />
            <button className="button secondary" type="submit" aria-label="Join room" disabled={!props.name.trim() || props.roomCode.length !== 10 || props.busy || props.connection !== 'connected'}>Join <span>→</span></button>
          </form>
          <p className="room-facts">2–4 PLAYERS <b>·</b> PRIVATE ROOMS <b>·</b> ONE HIDDEN MARK EACH</p>
        </div>
      </section>
      <section className="faction-intro" aria-label="The four factions">
        <div className="section-heading"><span>THE FOUR FACTIONS</span><i /></div>
        <div className="faction-grid">
          {FACTIONS.map((faction) => <article key={faction} className={`faction-card ${faction}`}><span className="faction-icon">{MARKS[faction].icon}</span><h2>{MARKS[faction].name}</h2><p>{MARKS[faction].line}</p></article>)}
        </div>
      </section>
    </>
  );
}

function LobbyScreen(props: {
  room: RoomPublicState; localPlayerId: string; mark: Faction | null; busy: boolean;
  onChooseMark: (mark: Faction) => void; onStart: () => void; onLeave: () => void;
}) {
  const isHost = props.room.hostPlayerId === props.localPlayerId;
  const self = props.room.players.find((player) => player.id === props.localPlayerId);
  const ready = props.room.players.length >= 2 && props.room.players.every((player) => player.markSelected);
  return (
    <section className="lobby-screen content-screen">
      <div className="screen-kicker"><span>PRIVATE ROOM</span><span>02 / GATHER</span></div>
      <div className="lobby-heading"><div><p className="eyebrow">THE TABLE IS SETTING</p><h1>Gather your<br /><em>grudges.</em></h1></div><div className="room-code-card"><span>ROOM CODE</span><strong>{roomCodeFor(props.room)}</strong><small>Share this with the other players</small></div></div>
      <div className="lobby-columns">
        <section className="panel seats-panel"><div className="panel-head"><div><span className="eyebrow">THE TABLE</span><h2>Players <small>{props.room.players.length} / 4</small></h2></div><span className="live-tag"><i /> LOBBY OPEN</span></div>
          <div className="seat-list">
            {props.room.players.map((player) => <article className={`seat-row ${player.id === props.localPlayerId ? 'is-you' : ''}`} key={player.id}>
              <div className="seat-number">0{player.seatNo}</div><div className="seat-identity"><strong>{player.displayName}{player.id === props.localPlayerId ? <small> YOU</small> : null}</strong><span>{player.id === props.room.hostPlayerId ? 'Room host' : 'Guest seat'}</span></div>
              <span className={`ready-state ${player.markSelected ? 'ready' : ''}`}><i />{player.markSelected ? (player.id === props.localPlayerId && props.mark ? `${factionName(props.mark)} locked` : 'Mark locked') : 'Choosing Mark'}</span>
            </article>)}
            {Array.from({ length: Math.max(0, 4 - props.room.players.length) }, (_, index) => <div className="seat-row empty-seat" key={`empty-${index}`}><div className="seat-number">0{props.room.players.length + index + 1}</div><div className="seat-identity"><strong>Waiting for a player</strong><span>Share the room code to invite</span></div><span className="waiting-label">OPEN SEAT</span></div>)}
          </div>
          <div className="lobby-footnote"><span className="status-glyph">✦</span><p>Marks stay hidden until the final score is revealed. No one else can see your choice.</p></div>
        </section>
        <section className="panel mark-panel"><div className="panel-head"><div><span className="eyebrow">YOUR SECRET ALLEGIANCE</span><h2>Choose a Mark</h2></div><span className="private-tag">PRIVATE</span></div>
          <div className="mark-options">
            {FACTIONS.map((faction) => <button key={faction} type="button" className={`mark-option ${faction} ${props.mark === faction ? 'selected' : ''}`} onClick={() => props.onChooseMark(faction)} disabled={props.busy || Boolean(self?.markSelected)} aria-pressed={props.mark === faction}>
              <span className="faction-icon">{MARKS[faction].icon}</span><span><strong>{MARKS[faction].name}</strong><small>{MARKS[faction].line}</small></span><span className="radio-mark">{props.mark === faction ? '✓' : ''}</span>
            </button>)}
          </div>
          <p className="mark-rule">Collect three or more relics of your Mark to earn a three-point bonus.</p>
          {isHost ? <button type="button" className="button primary full start-button" onClick={props.onStart} disabled={!ready || props.busy}>{props.busy ? 'Preparing the Vault…' : ready ? 'Start the match' : 'Waiting for players and Marks'} <span>↗</span></button> : <div className="host-wait"><span className="host-seal">✦</span><span>The host will start when everyone is ready.</span></div>}
          <button className="text-button" type="button" onClick={props.onLeave}>Leave this room</button>
        </section>
      </div>
      <button className="back-link" type="button" onClick={props.onLeave}>← Back to title</button>
    </section>
  );
}

function MatchScreen(props: {
  game: PlayerPublicState; room: RoomPublicState; localPlayerId: string; connection: Connection; busy: boolean;
  pendingHex: CardId | null; onPick: (id: CardId) => void; onCancelHex: () => void;
  onAssignHex: (playerId: string) => void; onLeave: () => void;
}) {
  const { game } = props;
  const canAct = props.connection === 'connected' && game.status === 'active' && game.currentPlayerId === props.localPlayerId && !props.busy && !props.pendingHex;
  const isFinal = game.status === 'complete';
  const current = game.players.find(({ id }) => id === game.currentPlayerId);
  return (
    <section className="match-screen content-screen">
      <div className="screen-kicker"><span>GRUDGE VAULT <i>/</i> MATCH</span><span>REVISION {String(game.revision).padStart(2, '0')}</span></div>
      <div className="match-header"><div><p className="eyebrow">{game.status === 'paused' ? 'THE TABLE IS PAUSED' : game.status === 'abandoned' ? 'THE MATCH HAS ENDED' : isFinal ? 'THE VAULT IS EMPTY' : 'THE DRAFT IS UNDERWAY'}</p><h1>{isFinal ? 'The reckoning.' : game.status === 'abandoned' ? 'A broken pact.' : 'The Vault.'}</h1></div><div className="match-meta"><span>ROOM</span><strong>{roomCodeFor(props.room)}</strong><span className="match-mark"><i className={`mark-dot ${game.you.mark}`} /> YOUR MARK: {factionName(game.you.mark).toUpperCase()}</span></div></div>
      {props.connection !== 'connected' && <div className="connection-banner"><span className="spinner small" /><div><strong>Reconnecting to your seat</strong><p>Your turn and Mark are saved. Actions will return when the connection is restored.</p></div></div>}
      {game.status === 'paused' && <div className="state-banner paused-banner"><span>Ⅱ</span><div><strong>The match is paused</strong><p>A player disconnected. Everyone can rejoin within 60 seconds to continue this exact game.</p></div></div>}
      {game.status === 'abandoned' && <div className="state-banner abandoned-banner"><span>⌁</span><div><strong>This match was abandoned</strong><p>The reconnect window expired. No winner was declared.</p></div></div>}
      {game.status === 'active' && <div className={`turn-banner ${canAct ? 'your-turn' : ''}`}><span className="turn-sigil">{canAct ? '✦' : '◷'}</span><div><strong>{canAct ? 'Your turn' : `${current?.displayName ?? 'A player'} is choosing`}</strong><p>{canAct ? (props.pendingHex ? 'Choose an opponent to receive this Hex.' : 'Choose one card from the Vault.') : 'Watch the Vault. The table updates as each turn resolves.'}</p></div><span className="turn-indicator">{canAct ? 'ACT' : 'WAIT'}</span></div>}

      {isFinal ? <ResultsPanel game={game} /> : (
        <>
          <div className="game-layout">
            <div className="game-main">
              <section className="vault-panel panel"><div className="vault-title"><div><span className="eyebrow">FIVE RELICS. FOUR HEXES.</span><h2>The Vault <small>{game.vault.length} left</small></h2></div><span className="vault-rule">{game.vault.length > 5 ? 'LAST DRAFT' : 'FACE UP'}</span></div>
                {game.vault.length ? <div className="vault-grid">{game.vault.map((cardId, index) => <VaultCard key={cardId} cardId={cardId} index={index} canAct={canAct} isPending={props.pendingHex === cardId} onPick={props.onPick} />)}</div> : <div className="empty-vault">The last card has been taken.</div>}
              </section>
              {props.pendingHex && <section className="hex-target-panel panel" aria-live="polite"><div className="hex-prompt"><div><span className="eyebrow">HEX TRANSFER REQUIRED</span><h2>Who carries {cardById(props.pendingHex).name}?</h2></div><button className="icon-button" onClick={props.onCancelHex} aria-label="Cancel Hex selection">×</button></div><div className="target-list">{game.players.filter((player) => player.id !== props.localPlayerId).map((player) => <button className="target-button" key={player.id} onClick={() => props.onAssignHex(player.id)} disabled={props.busy}><span className="target-mark">⌁</span><span><strong>{player.displayName}</strong><small>Send the Hex to this opponent</small></span><span>→</span></button>)}</div><p>The card leaves the Vault only after the server accepts the transfer.</p></section>}
            </div>
            <aside className="player-rail"><div className="rail-heading"><div><span className="eyebrow">THE PLAYERS</span><h2>At the table</h2></div><span>{game.players.length} seats</span></div>
              {game.players.map((player, index) => <PlayerCard key={player.id} player={player} index={index} isYou={player.id === props.localPlayerId} isCurrent={player.id === game.currentPlayerId} mark={player.id === props.localPlayerId ? game.you.mark : null} game={game} />)}
            </aside>
          </div>
          <div className="scoring-note"><span>SCORING</span><p>Faction sets score 1 · 3 · 6 · 10 · 15. Three of your Mark earns +3. Each Hex costs −3.</p></div>
          <p className="score-disclaimer">Score previews use visible collections. Only the server's final result is authoritative.</p>
        </>
      )}
      <button className="back-link" type="button" onClick={props.onLeave}>{isFinal || game.status === 'abandoned' ? 'Start another room' : 'Return to title on this device'}</button>
    </section>
  );
}

function VaultCard({ cardId, index, canAct, isPending, onPick }: { cardId: CardId; index: number; canAct: boolean; isPending: boolean; onPick: (id: CardId) => void }) {
  const card = cardById(cardId);
  const isHex = card.type === 'hex';
  const faction = isHex ? 'hex' : card.faction;
  return (
    <button type="button" className={`vault-card ${faction} ${canAct ? 'actionable' : ''} ${isPending ? 'pending' : ''}`} onClick={() => onPick(cardId)} disabled={!canAct || isPending} aria-label={`${card.name}, ${isHex ? 'Hex' : `${factionName(card.faction)} relic`}${canAct ? ', take card' : ''}`}>
      <span className="card-number">0{index + 1}</span><span className="card-glyph">{isHex ? '⌁' : MARKS[card.faction].icon}</span><span className="card-category">{isHex ? 'HEX' : card.faction.toUpperCase()}</span><strong>{card.name}</strong><span className="card-pick">{isHex ? 'TAKE & ASSIGN' : 'RELIC'} <i>↗</i></span>
    </button>
  );
}

function PlayerCard({ player, index, isYou, isCurrent, mark, game }: {
  player: PlayerPublicState['players'][number]; index: number; isYou: boolean; isCurrent: boolean; mark: Faction | null; game: PlayerPublicState;
}) {
  const counts: Record<Faction, number> = { ember: 0, tide: 0, thorn: 0, void: 0 };
  for (const id of player.heldRelicIds) {
    const card = cardById(id);
    if (card.type === 'relic') counts[card.faction] += 1;
  }
  const factionPoints = FACTIONS.reduce((sum, faction) => sum + scoreFaction(counts[faction]), 0);
  const hexPenalty = player.heldHexIds.length * 3;
  const markBonus = mark && counts[mark] >= 3 ? 3 : 0;
  const visibleScore = factionPoints - hexPenalty + markBonus;
  return (
    <article className={`player-card ${isYou ? 'is-you' : ''} ${isCurrent ? 'is-current' : ''}`}>
      <div className="player-card-top"><span className="player-index">0{index + 1}</span><span className="player-name">{player.displayName}{isYou ? <small> YOU</small> : null}</span>{isCurrent && game.status === 'active' && <span className="current-chip">TURN</span>}</div>
      <div className="player-totals"><span><b>{player.heldRelicIds.length}</b> relics</span><span className={hexPenalty ? 'hex-total' : ''}><b>{player.heldHexIds.length}</b> hexes</span></div>
      <div className="collection-dots">{FACTIONS.map((faction) => <span key={faction} className={`collection-dot ${faction} ${counts[faction] ? 'has-cards' : ''}`} title={`${factionName(faction)}: ${counts[faction]} relics`}><i />{counts[faction]}</span>)}</div>
      <div className="player-score"><span>VISIBLE SCORE</span><strong>{formatScore(visibleScore)}{!isYou && game.status !== 'complete' ? <small> + hidden Mark bonus</small> : null}</strong></div>
      {isYou && <div className="private-mark-label"><i className={`mark-dot ${mark ?? game.you.mark}`} /> YOUR MARK · {factionName(mark ?? game.you.mark).toUpperCase()}</div>}
      {isYou && player.heldHexIds.length > 0 && <div className="held-hexes">{player.heldHexIds.map((id) => <span key={id}>{cardById(id).name}</span>)}</div>}
    </article>
  );
}

function ResultsPanel({ game }: { game: PlayerPublicState }) {
  const result = game.status === 'complete' ? game.result : null;
  if (!result) return <section className="results-panel panel"><span className="eyebrow">NO FINAL SCORE</span><h2>The match ended without a result.</h2></section>;
  const scores = result.scores;
  return (
    <section className="results-panel panel"><div className="results-heading"><div><span className="eyebrow">THE VAULT HAS SPOKEN</span><h2>Final reckoning</h2></div><span className="final-seal">✦</span></div>
      <div className="winner-strip">{result.winnerPlayerIds.length > 1 ? 'SHARED VICTORY' : 'VAULT KEEPER'} <strong>{result.winnerPlayerIds.map((id) => game.players.find((player) => player.id === id)?.displayName).join(' & ')}</strong></div>
      <div className="result-list">{scores.map((score) => {
        const player = game.players.find(({ id }) => id === score.playerId)!;
        const winner = result.winnerPlayerIds.includes(score.playerId);
        return <article key={score.playerId} className={`result-row ${winner ? 'winner' : ''}`}><div className="result-player"><span className="result-rank">{winner ? '✦' : '—'}</span><span><strong>{player.displayName}</strong><small><i className={`mark-dot ${score.mark}`} /> {factionName(score.mark)} Mark revealed</small></span></div><div className="result-breakdown"><div className="faction-breakdown">{FACTIONS.map((faction) => <span key={faction}><i className={`mark-dot ${faction}`} />{score.factionScores[faction]}</span>)}</div><span className="result-bonus">Mark +{score.markBonus}</span><span className="result-hex">Hex −{score.hexPenalty}</span></div><strong className="result-total">{formatScore(score.total)}</strong></article>;
      })}</div>
      <p className="result-explainer">Faction points · your Mark bonus · Hex penalties. Final scores were calculated by the server.</p>
    </section>
  );
}

function connectionLabel(connection: Connection): string {
  return connection === 'connected' ? 'TABLE CONNECTED' : connection === 'reconnecting' ? 'RESTORING SEAT' : connection === 'connecting' ? 'CONNECTING' : 'OFFLINE';
}
function roomCodeFor(room: RoomPublicState): string {
  const saved = getStoredSession();
  return saved?.roomId === room.roomId && saved.roomCode ? saved.roomCode : '••••••••••';
}
function formatScore(score: number): string { return score > 0 ? `+${score}` : String(score); }
