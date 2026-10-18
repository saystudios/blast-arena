/*
 * Blast Arena — online layer (Phase 3).
 * Owns the WebSocket connection, sign-in token, and the Online / Room screens:
 * quick match, private rooms with codes, friends & invites, leaderboard, match history,
 * quick chat, report & block, rematch voting and automatic reconnection.
 * Talks to the game through BA.game (set up by game.js).
 */
(function () {
  'use strict';
  const BA = (window.BA = window.BA || {});
  const $ = (id) => document.getElementById(id);
  const NET_KEY = 'blastArena.net';
  const MODE_NAMES = { duel: '1v1 Duel', ffa: 'Free-for-All', team2: '2v2', team3: '3v3', team5: '5v5' };
  const REPORT_REASONS = [['cheating', 'Cheating'], ['mean', 'Mean behavior'], ['name', 'Bad name'], ['other', 'Something else']];

  BA.initOnline = function (G) {
    const C = window.BlastCore;
    let ws = null, wantOnline = false, retry = 0, retryTimer = null, pingTimer = null, rtt = 100;
    let me = null, room = null, friends = { friends: [], requests: [], blocked: [] }, queueState = null, quickChat = [];
    let qmMode = 'duel', boardTab = 'leaderboard', inMatch = false;

    const saved = () => { try { return JSON.parse(localStorage.getItem(NET_KEY) || '{}') || {}; } catch (e) { return {}; } };
    const remember = (o) => { try { localStorage.setItem(NET_KEY, JSON.stringify(Object.assign(saved(), o))); } catch (e) { /* private mode */ } };
    const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function serverUrl() {
      // Player-entered address wins; otherwise a build-time default from <meta name="blast-server"> (used by the iOS app build).
      const meta = document.querySelector('meta[name="blast-server"]');
      const custom = (G.store.settings.server || (meta && meta.content) || '').trim();
      if (custom) {
        if (/^wss?:\/\//i.test(custom)) return custom.replace(/\/?$/, '').replace(/(\/ws)?$/, '/ws');
        return (custom.startsWith('http://') ? 'ws://' : 'wss://') + custom.replace(/^https?:\/\//, '').replace(/\/$/, '') + '/ws';
      }
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        if (/claude\.ai|claudeusercontent|anthropic/.test(location.hostname)) return null;
        return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
      }
      return null;
    }

    // ------------------------------------------------------------ connection
    const net = {
      send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); },
      get connected() { return !!(ws && ws.readyState === 1 && me); }
    };
    G.setNet(net);

    function connect() {
      wantOnline = true;
      clearTimeout(retryTimer);
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
      const url = serverUrl();
      if (!url) { setStatus('none'); return; }
      setStatus('connecting');
      try { ws = new WebSocket(url); }
      catch (e) { setStatus('error'); return; }
      ws.onopen = () => {
        retry = 0;
        const s = G.store.settings;
        net.send({ t: 'hello', v: C.PROTOCOL, token: saved().token, outfit: s.outfit, loadout: s.loadout, allowInvites: s.allowInvites !== false });
        clearInterval(pingTimer);
        pingTimer = setInterval(() => net.send({ t: 'ping', c: performance.now(), rtt: Math.round(rtt) }), 2000);
      };
      ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } onMessage(m); };
      ws.onclose = () => {
        clearInterval(pingTimer);
        const wasMe = !!me;
        me = null; ws = null;
        if (wasMe) setStatus('reconnecting'); else setStatus('error');
        if (wantOnline) { retryTimer = setTimeout(connect, Math.min(10000, 1000 * Math.pow(2, retry++))); }
      };
      ws.onerror = () => { /* onclose follows */ };
    }
    function disconnect() {
      wantOnline = false;
      clearTimeout(retryTimer); clearInterval(pingTimer);
      if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
      ws = null; me = null;
    }

    function setStatus(s) {
      const el = $('netStatus');
      const text = { connecting: 'Connecting…', online: 'Online', reconnecting: 'Reconnecting…', error: 'Can’t reach the server', none: 'No server set' }[s] || s;
      el.textContent = text;
      el.className = 'net-status ' + s;
      $('onlineBody').hidden = s !== 'online';
      $('onlineHelp').hidden = s === 'online' || s === 'connecting' || s === 'reconnecting';
      if (inMatch && s === 'reconnecting') G.toast('Connection lost. Reconnecting…');
    }

    // ------------------------------------------------------------ messages
    function onMessage(m) {
      switch (m.t) {
        case 'welcome':
          me = m; quickChat = m.quickChat || [];
          remember({ token: m.token });
          G.setChatPhrases(quickChat);
          setStatus('online');
          renderProfile();
          net.send({ t: boardTab === 'leaderboard' ? 'leaderboard' : 'history' });
          return;
        case 'pong': rtt = rtt * 0.7 + (performance.now() - m.c) * 0.3; return;
        case 'name': me.name = m.name; renderProfile(); return;
        case 'error': G.toast(m.msg); return;
        case 'notice': G.toast(m.msg); return;
        case 'queue': queueState = m.mode ? m : null; renderQueue(); return;
        case 'room': onRoom(m.room); return;
        case 'friends': friends = m; renderFriends(); return;
        case 'invite':
          if (G.store.settings.allowInvites === false) return;
          G.toast(`${m.from} invited you to ${MODE_NAMES[m.mode] || 'a match'}`, [{ label: 'Join', run: () => { openOnline(); net.send({ t: 'room_join', code: m.code }); } }, { label: 'No thanks', run: () => {} }]);
          return;
        case 'leaderboard': renderBoard(m.rows, 'leaderboard'); return;
        case 'history': renderBoard(m.rows, 'history'); return;
        case 'chat': G.showChat(m.name, quickChat[m.i] || ''); return;
        case 'match_start':
          inMatch = true; queueState = null;
          G.startOnlineMatch(m);
          if (m.resume) G.toast('Back in the match!');
          return;
        case 'snap': if (inMatch) G.applySnapshot(m); return;
        case 'match_end':
          if (!inMatch) return;
          G.endOnlineMatch(m);
          decorateResults();
          return;
      }
    }

    function onRoom(r) {
      const prev = room;
      room = r;
      if (!r) {
        if (inMatch) { inMatch = false; G.leaveOnlineMatch(); }
        if (G.state.screen === 'room' || G.state.screen === 'results' || G.state.screen === null) openOnline();
        return;
      }
      if (r.state === 'results') updateVotes();
      if (r.state === 'lobby') {
        if (inMatch) { inMatch = false; G.leaveOnlineMatch(); }
        if (!prev || prev.code !== r.code || G.state.screen === 'online' || G.state.screen === 'results' || G.state.screen === 'menu') G.showScreen('room');
      }
      renderRoom();
    }

    // ------------------------------------------------------------ screens
    function openOnline() {
      G.showScreen('online');
      if (!net.connected) connect();
      else { renderProfile(); net.send({ t: 'profile', outfit: G.store.settings.outfit, loadout: G.store.settings.loadout, allowInvites: G.store.settings.allowInvites !== false }); }
    }

    function renderProfile() {
      if (!me) return;
      $('netName').textContent = me.name;
      $('netMeta').textContent = `Rating ${me.rating} · ${me.wins} wins · Friend code ${me.friendCode}`;
      renderQueue(); renderFriends();
    }

    function renderQueue() {
      $('qmModes').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === qmMode)));
      const q = queueState;
      $('qmFind').hidden = !!q; $('qmCancel').hidden = !q;
      $('qmStatus').textContent = q ? `Looking for players… ${q.count}/${q.needed} in ${MODE_NAMES[q.mode]} (${q.waited}s)` : 'Ranked. Matches start when enough players are ready.';
    }

    function renderFriends() {
      const list = $('friendList');
      const rows = [];
      for (const f of friends.requests) rows.push(`<div class="frow"><span class="fdot req"></span><b>${esc(f.name)}</b><small>wants to be friends</small><button class="mini-btn" data-act="accept" data-id="${f.id}">Accept</button><button class="mini-btn" data-act="decline" data-id="${f.id}">Decline</button></div>`);
      for (const f of friends.friends) rows.push(`<div class="frow"><span class="fdot ${f.online ? 'on' : ''}"></span><b>${esc(f.name)}</b><small>${esc(f.status)}</small>${f.online ? `<button class="mini-btn" data-act="invite" data-id="${f.id}">Invite</button>` : ''}<button class="mini-btn" data-act="remove" data-id="${f.id}">Remove</button></div>`);
      list.innerHTML = rows.length ? rows.join('') : '<p class="hint">No friends yet. Share your friend code, or add theirs.</p>';
      $('blockedList').innerHTML = friends.blocked.length ? 'Blocked: ' + friends.blocked.map((b) => `<span class="bchip">${esc(b.name)} <button class="link-btn" data-act="unblock" data-id="${b.id}">Unblock</button></span>`).join(' ') : '';
    }

    function renderBoard(rows, kind) {
      boardTab = kind;
      $('boardTabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === kind)));
      const t = $('boardTable');
      if (kind === 'leaderboard') {
        t.innerHTML = '<thead><tr><th>#</th><th>Player</th><th>Rating</th><th>Wins</th></tr></thead><tbody>' +
          (rows.length ? rows.map((r) => `<tr${me && r.name === me.name ? ' class="me"' : ''}><td>${r.rank}</td><td>${esc(r.name)}</td><td>${r.rating}</td><td>${r.wins}</td></tr>`).join('') : '<tr><td colspan="4">No ranked matches yet.</td></tr>') + '</tbody>';
      } else {
        const when = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        t.innerHTML = '<thead><tr><th>Date</th><th>Mode</th><th>Result</th><th>Blasts</th></tr></thead><tbody>' +
          (rows.length ? rows.map((r) => `<tr><td>${when(r.when)}</td><td>${MODE_NAMES[r.mode] || r.mode}</td><td class="res-${r.result}">${r.result}${r.ranked ? ` (${r.rating >= 0 ? '+' : ''}${r.rating})` : ''}</td><td>${r.kills}/${r.deaths}</td></tr>`).join('') : '<tr><td colspan="4">No matches yet.</td></tr>') + '</tbody>';
      }
    }

    function renderRoom() {
      if (!room) return;
      const host = me && room.host === me.id;
      $('roomCode').textContent = room.code;
      $('roomInfo').textContent = room.private ? 'Share this code with friends so they can join.' : 'Quick match';
      $('roomModes').querySelectorAll('button').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.v === room.mode)); b.disabled = !host; });
      $('roomMaps').querySelectorAll('button').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.v === room.map)); b.disabled = !host; });
      $('roomPlayers').innerHTML = room.players.map((p) => {
        const isMe = me && p.id === me.id;
        return `<div class="frow"><span class="fdot ${p.online ? 'on' : ''}"></span><b>${esc(p.name)}${isMe ? ' (you)' : ''}</b><small>${p.id === room.host ? 'Host' : ''}</small>${isMe ? '' : `<button class="mini-btn" data-act="report" data-id="${p.id}" data-name="${esc(p.name)}">Report</button><button class="mini-btn" data-act="block" data-id="${p.id}">Block</button>`}</div>`;
      }).join('');
      $('roomCount').textContent = `${room.players.length}/${room.capacity} players`;
      $('roomStart').hidden = !host;
      $('roomStart').disabled = room.players.length < 2;
      $('roomWait').hidden = host;
      $('roomInviteList').innerHTML = room.private ? friends.friends.filter((f) => f.online && !room.players.some((p) => p.id === f.id)).map((f) => `<button class="mini-btn" data-act="invite" data-id="${f.id}">Invite ${esc(f.name)}</button>`).join('') : '';
    }

    function updateVotes() {
      if (!room || G.state.screen !== 'results') return;
      const online = room.players.filter((p) => p.online).length;
      $('voteInfo').hidden = false;
      $('voteInfo').textContent = `Rematch votes: ${room.votes.length}/${online} · ${room.voteEnds}s`;
    }

    function decorateResults() {
      $('menuBtn').textContent = room && room.private ? 'Back to room' : 'Leave';
      $('voteInfo').hidden = false; $('voteInfo').textContent = 'Vote for a rematch to play again with the same group.';
      $('resultRows').querySelectorAll('tr').forEach((tr) => {
        if (!me || tr.dataset.id === me.id) return;
        const td = document.createElement('td');
        td.className = 'row-actions';
        td.innerHTML = `<button class="link-btn" data-act="report" data-id="${tr.dataset.id}" data-name="${esc(tr.dataset.name)}">Report</button> <button class="link-btn" data-act="block" data-id="${tr.dataset.id}">Block</button>`;
        tr.appendChild(td);
      });
    }

    // Report picker (fixed reasons, no free text)
    function openReport(id, name) {
      $('reportName').textContent = name;
      $('reportReasons').innerHTML = REPORT_REASONS.map(([v, l]) => `<button class="chip-btn" data-reason="${v}">${l}</button>`).join('');
      $('reportBox').dataset.id = id;
      $('reportBox').hidden = false;
    }
    $('reportBox').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.reason) net.send({ t: 'report', id: $('reportBox').dataset.id, reason: b.dataset.reason });
      $('reportBox').hidden = true;
    });

    // One delegated handler for every friend/room/result action button
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const id = b.dataset.id;
      switch (b.dataset.act) {
        case 'accept': net.send({ t: 'friend_accept', id }); break;
        case 'decline': case 'remove': net.send({ t: 'friend_remove', id }); break;
        case 'invite': net.send({ t: 'invite', id }); b.disabled = true; break;
        case 'unblock': net.send({ t: 'unblock', id }); break;
        case 'block': net.send({ t: 'block', id }); b.textContent = 'Blocked'; b.disabled = true; break;
        case 'report': openReport(id, b.dataset.name || 'this player'); break;
      }
    });

    // ------------------------------------------------------------ wiring
    $('onlineBtn').addEventListener('click', openOnline);
    $('onlineBack').addEventListener('click', () => { G.showScreen('menu'); G.renderStats(); });
    $('netRename').addEventListener('click', () => net.send({ t: 'rename' }));
    $('netCopy').addEventListener('click', () => {
      if (!me) return;
      const done = () => G.toast('Friend code copied');
      try { navigator.clipboard.writeText(me.friendCode).then(done, () => G.toast('Your friend code is ' + me.friendCode)); }
      catch (e) { G.toast('Your friend code is ' + me.friendCode); }
    });
    $('qmModes').innerHTML = Object.entries(MODE_NAMES).map(([id, n]) => `<button data-v="${id}"><b>${n}</b></button>`).join('');
    $('qmModes').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; qmMode = b.dataset.v; renderQueue(); });
    $('qmFind').addEventListener('click', () => net.send({ t: 'queue', mode: qmMode }));
    $('qmCancel').addEventListener('click', () => net.send({ t: 'unqueue' }));
    $('roomCreate').addEventListener('click', () => {
      const s = G.store.settings;
      net.send({ t: 'room_create', mode: MODE_NAMES[s.mode] ? s.mode : 'duel', map: s.map === 'yard' || !s.map ? 'neon' : s.map });
    });
    const joinCode = () => { const c = $('joinCode').value.trim().toUpperCase(); if (c.length === 5) net.send({ t: 'room_join', code: c }); else G.toast('Room codes have 5 letters.'); };
    $('joinBtn').addEventListener('click', joinCode);
    $('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinCode(); });
    $('friendAdd').addEventListener('click', () => { const c = $('friendCode').value.trim().toUpperCase(); if (c) net.send({ t: 'friend_add', code: c }); $('friendCode').value = ''; });
    $('boardTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; net.send({ t: b.dataset.v }); });
    $('roomModes').innerHTML = Object.entries(MODE_NAMES).map(([id, n]) => `<button data-v="${id}"><b>${n}</b></button>`).join('');
    $('roomMaps').innerHTML = ['neon', 'candy', 'sky', 'yard'].map((id) => `<button data-v="${id}"><b>${BA.MAPS[id].name}</b></button>`).join('');
    $('roomModes').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && room) net.send({ t: 'room_settings', mode: b.dataset.v, map: room.map }); });
    $('roomMaps').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && room) net.send({ t: 'room_settings', mode: room.mode, map: b.dataset.v }); });
    $('roomStart').addEventListener('click', () => net.send({ t: 'room_start' }));
    $('roomLeave').addEventListener('click', () => { net.send({ t: 'room_leave' }); room = null; openOnline(); });
    $('serverSave').addEventListener('click', () => {
      G.store.settings.server = $('serverUrl').value.trim(); G.persist();
      disconnect(); connect();
    });
    $('serverUrl').value = G.store.settings.server || '';

    G.hooks.leaveMatch = () => {
      net.send({ t: 'room_leave' });
      inMatch = false; room = null;
      G.leaveOnlineMatch();
      openOnline();
    };
    G.hooks.resultsBack = () => {
      if (room && room.private) { net.send({ t: 'vote', yes: false }); inMatch = false; G.leaveOnlineMatch(); G.showScreen('room'); renderRoom(); }
      else G.hooks.leaveMatch();
    };

    // Reconnect automatically if a token exists and we were in a match (e.g. the app was backgrounded).
    if (saved().token && serverUrl()) connect();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wantOnline && !ws) connect(); });

    BA.net = net;
  };
})();
