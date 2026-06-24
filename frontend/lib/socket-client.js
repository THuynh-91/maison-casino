/*
 * lib/socket-client.js — thin wrapper around the socket.io client (global `io`).
 *
 * Centralizes: connection, the persistent identity (persistentId + name in
 * localStorage), promise-based ack helpers for the request/response events the
 * backend exposes, and a tiny event bus for server-pushed events
 * ("games:list", "room:state", "room:kicked", connect/disconnect).
 *
 * Backend contract (see backend/server.js):
 *   emit room:create {name,persistentId}     -> ack {ok,error?,code?,you?,state?}
 *   emit room:join   {code,name,persistentId} -> ack {ok,...}
 *   emit game:select {gameId}                 -> ack {ok,error?}
 *   emit game:action {type,...}               -> ack {ok,error?}
 *   emit admin:login {password}               -> ack {ok,error?}
 *   emit admin:action {type,persistentId,amount,gameId} -> ack {ok}
 *   emit state:get                            -> ack {ok,state?}
 *   server pushes: games:list, room:state, room:kicked
 */
(function () {
  "use strict";

  const NS = "casino.";
  function getPersistentId() {
    let id = localStorage.getItem(NS + "pid");
    if (!id) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : "pid-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(NS + "pid", id);
    }
    return id;
  }
  function getName() {
    return localStorage.getItem(NS + "name") || "";
  }
  function setName(name) {
    localStorage.setItem(NS + "name", name || "");
  }

  class CasinoSocket {
    constructor() {
      this.persistentId = getPersistentId();
      this.socket = null;
      this.listeners = Object.create(null); // event -> Set(fn)
      this.lastGamesList = null;
      this.lastState = null;
    }

    connect() {
      if (this.socket) return this.socket;
      // io() defaults to same-origin — exactly what the backend serves.
      const s = io({ transports: ["websocket", "polling"] });
      this.socket = s;

      s.on("connect", () => this._emitLocal("connect"));
      s.on("disconnect", (reason) => this._emitLocal("disconnect", reason));
      s.on("connect_error", (err) => this._emitLocal("connect_error", err));

      s.on("games:list", (games) => {
        this.lastGamesList = games;
        this._emitLocal("games:list", games);
      });
      s.on("room:state", (state) => {
        this.lastState = state;
        this._emitLocal("room:state", state);
      });
      s.on("room:kicked", () => this._emitLocal("room:kicked"));
      return s;
    }

    // ---- local event bus -------------------------------------------------
    on(event, fn) {
      (this.listeners[event] || (this.listeners[event] = new Set())).add(fn);
      return () => this.off(event, fn);
    }
    off(event, fn) {
      if (this.listeners[event]) this.listeners[event].delete(fn);
    }
    _emitLocal(event, ...args) {
      const set = this.listeners[event];
      if (set) for (const fn of Array.from(set)) {
        try { fn(...args); } catch (e) { console.error("listener error for", event, e); }
      }
    }

    // ---- ack-based request helper ---------------------------------------
    _request(event, payload) {
      return new Promise((resolve) => {
        if (!this.socket) this.connect();
        let settled = false;
        const done = (res) => { if (!settled) { settled = true; resolve(res); } };
        // guard against a server that never acks
        const timer = setTimeout(() => done({ ok: false, error: "Request timed out" }), 8000);
        this.socket.emit(event, payload, (res) => {
          clearTimeout(timer);
          done(res || { ok: true });
        });
      });
    }

    // ---- typed convenience methods --------------------------------------
    createRoom(name) {
      setName(name);
      return this._request("room:create", { name, persistentId: this.persistentId });
    }
    joinRoom(code, name) {
      setName(name);
      return this._request("room:join", { code: String(code || "").toUpperCase(), name, persistentId: this.persistentId });
    }
    selectGame(gameId) {
      return this._request("game:select", { gameId });
    }
    gameAction(action) {
      return this._request("game:action", action);
    }
    getState() {
      return this._request("state:get", {});
    }
    adminLogin(password) {
      return this._request("admin:login", { password });
    }
    adminAction(action) {
      return this._request("admin:action", action);
    }
  }

  const instance = new CasinoSocket();
  instance.getName = getName;
  instance.setName = setName;
  window.casinoSocket = instance;
})();
