/*
 * lib/ui.js — shared, dependency-free UI helpers.
 * Exposes a global `UI` with: el(), toast(), modal(), and a few formatters.
 * No framework — just small DOM utilities used across the lobby, room and games.
 */
(function () {
  "use strict";

  /**
   * el(tag, props?, children?) — terse hyperscript-style element builder.
   *   el("button", { class: "btn btn-primary", onclick: fn }, "Go")
   *   el("div", { class: "row" }, [child1, child2])
   * props special-cases: class/className, dataset, style (object), on* handlers,
   * and `html` (innerHTML). Everything else becomes an attribute.
   */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props && typeof props === "object" && !isNode(props) && !Array.isArray(props)) {
      for (const key in props) {
        const val = props[key];
        if (val == null || val === false) continue;
        if (key === "class" || key === "className") node.className = val;
        else if (key === "html") node.innerHTML = val;
        else if (key === "text") node.textContent = val;
        else if (key === "dataset") Object.assign(node.dataset, val);
        else if (key === "style" && typeof val === "object") Object.assign(node.style, val);
        else if (key.startsWith("on") && typeof val === "function") {
          node.addEventListener(key.slice(2).toLowerCase(), val);
        } else if (val === true) node.setAttribute(key, "");
        else node.setAttribute(key, val);
      }
    } else {
      // props omitted; treat as children
      children = props;
    }
    appendChildren(node, children);
    return node;
  }

  function isNode(x) {
    return x instanceof Node;
  }

  function appendChildren(node, children) {
    if (children == null) return;
    if (Array.isArray(children)) {
      children.forEach((c) => appendChildren(node, c));
    } else if (isNode(children)) {
      node.appendChild(children);
    } else {
      node.appendChild(document.createTextNode(String(children)));
    }
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  // ---- Toasts ----------------------------------------------------------
  let toastHost = null;
  function ensureToastHost() {
    if (!toastHost) toastHost = document.getElementById("toast-host");
    return toastHost;
  }

  /** toast(message, kind?) — kind: "info" | "success" | "error". Auto-dismisses. */
  function toast(message, kind, ms) {
    const host = ensureToastHost();
    if (!host) return;
    const t = el("div", { class: "toast toast--" + (kind || "info") }, message);
    host.appendChild(t);
    const life = ms || (kind === "error" ? 4200 : 2800);
    setTimeout(() => {
      t.classList.add("toast--out");
      setTimeout(() => t.remove(), 260);
    }, life);
    return t;
  }

  // ---- Modal -----------------------------------------------------------
  let modalHost = null;
  let activeModal = null;
  function ensureModalHost() {
    if (!modalHost) modalHost = document.getElementById("modal-host");
    return modalHost;
  }

  /**
   * modal({ title, body, onClose }) -> { close(), root, body }
   * `body` may be a Node, a string, or a function(api) returning a Node.
   * Closes on overlay click, the X button, or Escape.
   */
  function modal(opts) {
    opts = opts || {};
    const host = ensureModalHost();
    closeModal(); // only one at a time

    const closeBtn = el("button", {
      class: "btn btn-ghost modal__close",
      "aria-label": "Close",
      onclick: () => api.close(),
    }, "✕");

    const head = el("div", { class: "modal__head" }, [
      opts.title ? el("h3", { class: "modal__title" }, opts.title) : null,
      closeBtn,
    ]);

    const bodyWrap = el("div", { class: "modal__body" });

    const card = el("div", { class: "modal", role: "dialog", "aria-modal": "true" }, [head, bodyWrap]);
    const overlay = el("div", { class: "overlay", onclick: (e) => { if (e.target === overlay) api.close(); } }, card);

    const api = {
      root: overlay,
      body: bodyWrap,
      close() {
        if (activeModal !== api) return;
        document.removeEventListener("keydown", onKey);
        overlay.classList.add("overlay--out");
        setTimeout(() => overlay.remove(), 200);
        activeModal = null;
        if (opts.onClose) opts.onClose();
      },
    };

    let content = opts.body;
    if (typeof content === "function") content = content(api);
    appendChildren(bodyWrap, content);

    function onKey(e) {
      if (e.key === "Escape") api.close();
    }
    document.addEventListener("keydown", onKey);

    host.appendChild(overlay);
    activeModal = api;
    // focus the first focusable element for accessibility
    setTimeout(() => {
      const f = card.querySelector("input,button,select,textarea");
      if (f) f.focus();
    }, 30);
    return api;
  }

  function closeModal() {
    if (activeModal) activeModal.close();
  }

  // ---- Misc formatters -------------------------------------------------
  function money(n) {
    const v = Math.round(Number(n) || 0);
    return "$" + v.toLocaleString("en-US");
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // fallback
    return new Promise((resolve) => {
      const ta = el("textarea", { style: { position: "fixed", opacity: "0" } });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e) {}
      ta.remove();
      resolve();
    });
  }

  window.UI = { el, clear, toast, modal, closeModal, money, copyToClipboard, appendChildren };
})();
