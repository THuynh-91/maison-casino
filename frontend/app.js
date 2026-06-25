/*
 * app.js — single-page app controller.
 *
 *   - Lobby screen (create/join a room)
 *   - Room shell (sticky nav, players panel, game picker)
 *   - Game router: renders the selected game's view into the main area.
 *
 * GAME ROUTER / REGISTRY PATTERN
 * ------------------------------
 * Each game view registers itself on the global `window.CasinoGames` map under
 * its gameId:
 *
 *   window.CasinoGames.roulette = {
 *     mount(container, ctx) {},  // build DOM once when this game is selected
 *     update(state) {},          // called on every room:state
 *     unmount() {},              // tear down when leaving the game
 *   };
 *
 * `ctx` passed to mount():
 *   { socket, persistentId, getState(), getMyPlayer(), getPlayers(), gameInfo }
 *
 * If no renderer is registered for room.gameId we render a graceful
 * "view coming soon for <game>" placeholder. This lets other workers drop in
 * blackjack/slots/plinko/poker just by assigning window.CasinoGames[id].
 */
(function () {
  "use strict";

  const { el, clear, toast, modal, money, copyToClipboard } = window.UI;
  const socket = window.casinoSocket;

  // The extensible game-view registry. Other workers assign into this.
  window.CasinoGames = window.CasinoGames || {};

  // ---- App state -------------------------------------------------------
  const state = {
    screen: "lobby", // "lobby" | "room"
    roomState: null, // last room:state payload {code,gameId,players,game}
    gamesList: socket.lastGamesList || [],
    isAdmin: false,
    mountedGameId: null, // gameId whose view is currently mounted
    gameContainer: null,
  };

  const appRoot = document.getElementById("app");

  // ---- Theme toggle (persisted) ---------------------------------------
  const THEME_KEY = "casino.theme";
  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    const theme = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
  }
  function themeToggleBtn() {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    return el("button", {
      class: "btn btn-ghost icon-btn",
      title: "Toggle light/dark",
      "aria-label": "Toggle theme",
      onclick: (e) => {
        toggleTheme();
        e.currentTarget.textContent = document.documentElement.getAttribute("data-theme") === "dark" ? "☀" : "☾";
      },
    }, isDark ? "☀" : "☾");
  }
  initTheme();

  // ---- helpers ---------------------------------------------------------
  function getPlayers() {
    return (state.roomState && state.roomState.players) || [];
  }
  function getMyPlayer() {
    return getPlayers().find((p) => p.id === socket.persistentId) || null;
  }
  function gameInfoFor(id) {
    return (state.gamesList || []).find((g) => g.id === id) || null;
  }

  // =====================================================================
  // LOBBY
  // =====================================================================
  function renderLobby() {
    state.screen = "lobby";
    teardownGame();
    const savedName = socket.getName();

    const nameInput = el("input", {
      class: "input",
      id: "lobby-name",
      placeholder: "Your name",
      maxlength: "24",
      value: savedName,
      autocomplete: "off",
    });
    const codeInput = el("input", {
      class: "input",
      id: "lobby-code",
      placeholder: "Room code (e.g. K7P2Q)",
      maxlength: "8",
      autocomplete: "off",
      style: { textTransform: "uppercase" },
    });

    function nameOrWarn() {
      const n = nameInput.value.trim();
      if (!n) {
        nameInput.focus();
        toast("Enter a name first.", "error");
        return null;
      }
      return n;
    }

    async function doCreate() {
      const n = nameOrWarn();
      if (!n) return;
      const res = await socket.createRoom(n);
      if (res.ok) {
        applyJoinResult(res);
        toast("Room " + res.code + " created.", "success");
      } else {
        toast(res.error || "Could not create room.", "error");
      }
    }
    async function doJoin() {
      const n = nameOrWarn();
      if (!n) return;
      const code = codeInput.value.trim().toUpperCase();
      if (!code) { codeInput.focus(); toast("Enter a room code.", "error"); return; }
      const res = await socket.joinRoom(code, n);
      if (res.ok) {
        applyJoinResult(res);
        toast("Joined room " + res.code + ".", "success");
      } else {
        toast(res.error || "Could not join room.", "error");
      }
    }

    codeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doJoin(); });
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doCreate(); });

    const hero = el("section", { class: "lobby rise-in" }, [
      el("div", { class: "lobby__inner" }, [
        el("span", { class: "pill accent lobby__eyebrow" }, "Live multiplayer tables"),
        el("h1", { class: "display display-xl lobby__title" }, "Maison Roulette"),
        el("p", { class: "lead lobby__lead" },
          "A warm, editorial casino floor. Spin a single-zero European wheel together — " +
          "everyone shares the table, the chips, and the very same result."),
        el("div", { class: "lobby__card card" }, [
          el("label", { class: "field" }, [
            el("span", { class: "field__label" }, "Name"),
            nameInput,
          ]),
          el("div", { class: "lobby__actions" }, [
            el("button", { class: "btn btn-primary lobby__create", onclick: doCreate }, "Create Room"),
            el("div", { class: "lobby__join" }, [
              codeInput,
              el("button", { class: "btn btn-secondary", onclick: doJoin }, "Join"),
            ]),
          ]),
        ]),
        el("p", { class: "caption lobby__note" },
          "Your chips and identity persist on this device. Share the room code to invite friends."),
      ]),
    ]);

    clear(appRoot).appendChild(hero);
    setTimeout(() => nameInput.focus(), 40);
  }

  function applyJoinResult(res) {
    state.roomState = res.state || state.roomState;
    if (res.you && res.you.isAdmin) state.isAdmin = true;
    renderRoom();
  }

  // =====================================================================
  // ROOM SHELL
  // =====================================================================
  function renderRoom() {
    state.screen = "room";
    const rs = state.roomState || {};
    const nav = buildNav(rs);
    const players = el("aside", { class: "room__players", id: "players-panel" });
    const picker = el("section", { class: "room__picker", id: "game-picker" });
    const main = el("main", { class: "room__main", id: "game-main" });
    state.gameContainer = main;

    const body = el("div", { class: "room__body" }, [
      el("div", { class: "room__sidebar" }, [players, picker]),
      main,
    ]);

    clear(appRoot).appendChild(el("div", { class: "room rise-in" }, [nav, body]));

    renderPlayers();
    renderPicker();
    routeGame();
  }

  function buildNav(rs) {
    const code = rs.code || "—";
    const me = getMyPlayer();

    const codePill = el("button", {
      class: "pill accent code-pill",
      title: "Copy room code",
      onclick: () => {
        copyToClipboard(code).then(() => toast("Room code " + code + " copied — share it to invite friends.", "success"));
      },
    }, [el("span", { class: "code-pill__label" }, "ROOM"), el("strong", { class: "code-pill__code" }, code), el("span", { class: "code-pill__copy" }, "⧉")]);

    const balancePill = el("div", { class: "pill nav__balance", id: "nav-balance" },
      me ? [el("span", { class: "nav__balance-label" }, me.name), el("strong", { id: "nav-balance-val" }, money(me.balance))]
         : "—");

    return el("nav", { class: "nav room__nav" }, [
      el("div", { class: "nav__brand" }, [
        el("span", { class: "nav__logo display" }, "M"),
        el("span", { class: "nav__title" }, "Maison"),
      ]),
      codePill,
      el("div", { class: "nav__spacer" }),
      balancePill,
      el("button", { class: "btn btn-ghost icon-btn", title: "Admin panel", "aria-label": "Admin", onclick: openAdminModal }, "⚙"),
      themeToggleBtn(),
      el("button", { class: "btn btn-secondary", onclick: leaveRoom }, "Leave"),
    ]);
  }

  function leaveRoom() {
    // We just return to the lobby locally; the server marks us disconnected
    // when the socket actually drops. Reloading keeps identity (localStorage).
    state.roomState = null;
    state.isAdmin = false;
    teardownGame();
    renderLobby();
    // Best effort: reconnect a fresh socket so the old room membership clears.
    if (socket.socket) socket.socket.disconnect().connect();
  }

  function renderPlayers() {
    const panel = document.getElementById("players-panel");
    if (!panel) return;
    const players = getPlayers();
    clear(panel);
    panel.appendChild(el("h4", { class: "panel__title" }, "Players · " + players.length));
    const list = el("ul", { class: "player-list" });
    players
      .slice()
      .sort((a, b) => b.balance - a.balance)
      .forEach((p) => {
        const isMe = p.id === socket.persistentId;
        list.appendChild(el("li", { class: "player" + (isMe ? " player--me" : "") }, [
          el("span", { class: "player__dot " + (p.connected ? "is-on" : "is-off"), title: p.connected ? "Connected" : "Disconnected" }),
          el("span", { class: "player__name" }, [p.name, isMe ? el("span", { class: "player__you" }, "you") : null, p.isAdmin ? el("span", { class: "player__admin" }, "admin") : null]),
          el("span", { class: "player__balance" }, money(p.balance)),
        ]));
      });
    panel.appendChild(list);
  }

  function renderPicker() {
    const picker = document.getElementById("game-picker");
    if (!picker) return;
    const games = state.gamesList || [];
    const currentId = state.roomState && state.roomState.gameId;
    clear(picker);
    picker.appendChild(el("h4", { class: "panel__title" }, "Choose a table"));
    const grid = el("div", { class: "game-cards" });
    games.forEach((g) => {
      const selected = g.id === currentId;
      const card = el("button", {
        class: "game-card card card--interactive" + (selected ? " is-selected" : "") + (g.available ? "" : " is-unavailable"),
        onclick: () => pickGame(g.id),
        title: g.available ? "Play " + g.title : g.title + " (coming soon)",
      }, [
        el("div", { class: "game-card__icon", "aria-hidden": "true" }, gameGlyph(g.id)),
        el("div", { class: "game-card__title" }, g.title),
        el("div", { class: "game-card__blurb caption" }, g.blurb || ""),
        selected ? el("span", { class: "game-card__badge pill accent" }, "At the table") : null,
        !g.available ? el("span", { class: "game-card__badge pill" }, "Soon") : null,
      ]);
      grid.appendChild(card);
    });
    picker.appendChild(grid);
  }

  function gameGlyph(id) {
    return { roulette: "◉", blackjack: "♠", slots: "🎰", plinko: "⛁", poker: "♣" }[id] || "◆";
  }

  async function pickGame(gameId) {
    const res = await socket.selectGame(gameId);
    if (!res.ok) toast(res.error || "Could not select game.", "error");
    // room:state push will trigger re-route; no optimistic switch needed.
  }

  // =====================================================================
  // GAME ROUTER
  // =====================================================================
  function gameCtx() {
    return {
      socket,
      persistentId: socket.persistentId,
      getState: () => state.roomState,
      getMyPlayer,
      getPlayers,
      get gameInfo() { return gameInfoFor(state.roomState && state.roomState.gameId); },
    };
  }

  function routeGame() {
    const container = state.gameContainer;
    if (!container) return;
    const gameId = (state.roomState && state.roomState.gameId) || "lobby";

    // If the mounted view no longer matches, tear it down.
    if (state.mountedGameId && state.mountedGameId !== gameId) {
      teardownGame();
    }

    if (gameId === "lobby") {
      if (!state.mountedGameId) {
        clear(container).appendChild(emptyTableView());
      }
      return;
    }

    const renderer = window.CasinoGames[gameId];
    if (renderer && typeof renderer.mount === "function") {
      if (state.mountedGameId !== gameId) {
        clear(container);
        state.mountedGameId = gameId;
        try {
          renderer.mount(container, gameCtx());
        } catch (e) {
          console.error("game mount failed:", e);
          clear(container).appendChild(comingSoonView(gameId, true));
          state.mountedGameId = null;
          return;
        }
      }
      if (typeof renderer.update === "function") {
        try { renderer.update(state.roomState); } catch (e) { console.error("game update failed:", e); }
      }
    } else {
      // Graceful default for games other workers haven't shipped yet.
      if (state.mountedGameId !== gameId) {
        clear(container).appendChild(comingSoonView(gameId, false));
        state.mountedGameId = gameId;
      }
    }
  }

  function teardownGame() {
    if (state.mountedGameId) {
      const r = window.CasinoGames[state.mountedGameId];
      if (r && typeof r.unmount === "function") {
        try { r.unmount(); } catch (e) { console.error("unmount failed:", e); }
      }
      state.mountedGameId = null;
    }
  }

  function emptyTableView() {
    return el("div", { class: "table-empty rise-in" }, [
      el("div", { class: "table-empty__glyph", "aria-hidden": "true" }, "◉"),
      el("h2", {}, "Pick a table to begin"),
      el("p", { class: "lead" }, "Choose a game from the panel. Everyone in the room plays together."),
    ]);
  }

  function comingSoonView(gameId, errored) {
    const info = gameInfoFor(gameId);
    const title = info ? info.title : gameId;
    return el("div", { class: "table-empty rise-in" }, [
      el("div", { class: "table-empty__glyph", "aria-hidden": "true" }, gameGlyph(gameId)),
      el("h2", {}, (errored ? "Could not load " : "View coming soon for ") + title),
      el("p", { class: "lead" }, errored
        ? "Something went wrong rendering this table."
        : "This table is being built by another worker. The game is live on the server — its view just isn't here yet."),
    ]);
  }

  // =====================================================================
  // ADMIN PANEL
  // =====================================================================
  function openAdminModal() {
    if (!state.roomState) { toast("Join a room first.", "error"); return; }
    if (state.isAdmin) return showAdminPanel();

    modal({
      title: "Admin access",
      body: (api) => {
        const pw = el("input", { class: "input", type: "password", placeholder: "Admin password", autocomplete: "off" });
        pw.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
        async function submit() {
          const res = await socket.adminLogin(pw.value);
          if (res.ok) {
            state.isAdmin = true;
            api.close();
            toast("Admin unlocked.", "success");
            showAdminPanel();
          } else {
            toast(res.error || "Wrong password.", "error");
            pw.select();
          }
        }
        return el("div", { class: "stack" }, [
          el("p", { class: "caption" }, "Enter the admin password to manage chips, balances, and the table."),
          el("label", { class: "field" }, [el("span", { class: "field__label" }, "Password"), pw]),
          el("div", { class: "modal__actions" }, [
            el("button", { class: "btn btn-ghost", onclick: () => api.close() }, "Cancel"),
            el("button", { class: "btn btn-primary", onclick: submit }, "Unlock"),
          ]),
        ]);
      },
    });
  }

  function showAdminPanel() {
    const dlg = modal({ title: "Admin panel", body: () => buildAdminBody() });
    // re-render the admin body live as room state changes while it's open
    const stop = socket.on("room:state", () => {
      if (document.body.contains(dlg.body)) {
        clear(dlg.body).appendChild(buildAdminBody());
      } else {
        stop();
      }
    });
    const origClose = dlg.close;
    dlg.close = function () { stop(); origClose(); };
  }

  function buildAdminBody() {
    const players = getPlayers();
    const wrap = el("div", { class: "stack admin" });

    // Grant-all + game selector row
    const grantAllInput = el("input", { class: "input admin__amt", type: "number", min: "1", placeholder: "Amount", value: "500" });
    const gameSelect = el("select", { class: "input" },
      (state.gamesList || []).map((g) => el("option", { value: g.id, selected: state.roomState.gameId === g.id }, g.title)));
    gameSelect.appendChild(el("option", { value: "lobby", selected: state.roomState.gameId === "lobby" }, "Lobby (no game)"));

    wrap.appendChild(el("div", { class: "admin__row admin__global" }, [
      el("div", { class: "admin__group" }, [
        el("span", { class: "field__label" }, "Grant ALL players"),
        el("div", { class: "admin__inline" }, [
          grantAllInput,
          el("button", {
            class: "btn btn-primary", onclick: async () => {
              const amt = parseInt(grantAllInput.value, 10);
              if (!(amt > 0)) return toast("Enter a positive amount.", "error");
              const res = await socket.adminAction({ type: "grantAll", amount: amt });
              toast(res.ok ? "Granted " + money(amt) + " to everyone." : (res.error || "Failed."), res.ok ? "success" : "error");
            },
          }, "Grant all"),
        ]),
      ]),
      el("div", { class: "admin__group" }, [
        el("span", { class: "field__label" }, "Table"),
        el("div", { class: "admin__inline" }, [
          gameSelect,
          el("button", {
            class: "btn btn-secondary", onclick: async () => {
              const res = await socket.adminAction({ type: "selectGame", gameId: gameSelect.value });
              toast(res.ok ? "Table changed." : (res.error || "Failed."), res.ok ? "success" : "error");
            },
          }, "Set table"),
        ]),
      ]),
    ]));

    wrap.appendChild(el("div", { class: "admin__divider" }));

    // Per-player controls
    const list = el("div", { class: "admin__players" });
    players.forEach((p) => {
      const amtInput = el("input", { class: "input admin__amt", type: "number", min: "1", placeholder: "Amount" });
      list.appendChild(el("div", { class: "admin__player" }, [
        el("div", { class: "admin__pinfo" }, [
          el("span", { class: "player__dot " + (p.connected ? "is-on" : "is-off") }),
          el("strong", {}, p.name),
          el("span", { class: "admin__bal pill" }, money(p.balance)),
        ]),
        el("div", { class: "admin__inline" }, [
          amtInput,
          el("button", {
            class: "btn btn-secondary btn--sm", onclick: async () => {
              const amt = parseInt(amtInput.value, 10);
              if (!(amt > 0)) return toast("Enter a positive amount.", "error");
              const res = await socket.adminAction({ type: "grant", persistentId: p.id, amount: amt });
              toast(res.ok ? "Granted " + money(amt) + " to " + p.name + "." : (res.error || "Failed."), res.ok ? "success" : "error");
            },
          }, "Grant"),
          el("button", {
            class: "btn btn-secondary btn--sm", onclick: async () => {
              const amt = parseInt(amtInput.value, 10);
              if (!(amt >= 0)) return toast("Enter an amount (0 or more).", "error");
              const res = await socket.adminAction({ type: "setBalance", persistentId: p.id, amount: amt });
              toast(res.ok ? "Set " + p.name + " to " + money(amt) + "." : (res.error || "Failed."), res.ok ? "success" : "error");
            },
          }, "Set"),
          el("button", {
            class: "btn btn--sm admin__kick", onclick: async () => {
              const res = await socket.adminAction({ type: "kick", persistentId: p.id });
              toast(res.ok ? "Kicked " + p.name + "." : (res.error || "Failed."), res.ok ? "success" : "error");
            },
          }, "Kick"),
        ]),
      ]));
    });
    wrap.appendChild(el("div", { class: "admin__group" }, [el("span", { class: "field__label" }, "Players"), list]));

    return wrap;
  }

  // =====================================================================
  // SOCKET WIRING
  // =====================================================================
  socket.on("games:list", (games) => {
    state.gamesList = games;
    if (state.screen === "room") renderPicker();
  });

  socket.on("room:state", (rs) => {
    state.roomState = rs;
    // keep isAdmin in sync with the server's view of me
    const me = getMyPlayer();
    if (me) state.isAdmin = !!me.isAdmin;
    if (state.screen !== "room") return;
    renderPlayers();
    renderPicker();
    updateNavBalance();
    routeGame();
  });

  socket.on("room:kicked", () => {
    toast("You were removed from the room by an admin.", "error", 5000);
    state.roomState = null;
    state.isAdmin = false;
    teardownGame();
    renderLobby();
  });

  socket.on("disconnect", () => {
    if (state.screen === "room") toast("Connection lost — reconnecting…", "error");
  });
  socket.on("connect", () => {
    // On reconnect while in a room, refresh authoritative state.
    if (state.screen === "room") socket.getState().then((res) => {
      if (res.ok && res.state) {
        state.roomState = res.state;
        renderPlayers(); renderPicker(); updateNavBalance(); routeGame();
      }
    });
  });

  function updateNavBalance() {
    const me = getMyPlayer();
    const valEl = document.getElementById("nav-balance-val");
    if (valEl && me) {
      const prev = valEl.dataset.v;
      valEl.textContent = money(me.balance);
      if (prev != null && Number(prev) !== me.balance) {
        valEl.classList.remove("bump");
        void valEl.offsetWidth;
        valEl.classList.add("bump");
      }
      valEl.dataset.v = String(me.balance);
    }
  }

  // ---- boot ------------------------------------------------------------
  socket.connect();
  renderLobby();
})();

// ---- keep-alive --------------------------------------------------------
// The free-tier host sleeps after ~15 min idle. While this tab is open, ping
// the server's /healthz every 10 min so it stays warm during a session.
(function keepAlive() {
  const PING_INTERVAL = 10 * 60 * 1000; // 10 minutes
  function ping() {
    fetch("/healthz", { cache: "no-store" }).catch(() => {});
  }
  ping();
  setInterval(ping, PING_INTERVAL);
})();
