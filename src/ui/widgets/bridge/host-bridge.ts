// MCP Apps host bridge bootstrap (SEP-1865) — dual-mode + self-diagnosing.
//
// Bundled (esbuild → IIFE) by scripts/dev/build-widgets.mjs and injected into
// every widget HTML at the `<!-- MCP_HOST_BRIDGE -->` marker.
//
// Microsoft 365 Copilot documents support for BOTH host bridges
// (learn.microsoft.com/.../plugin-mcp-apps "Component bridge"):
//   • OpenAI Apps SDK  → `window.openai.*` (toolOutput, callTool, theme, …)
//   • MCP Apps         → `App` from `@modelcontextprotocol/ext-apps`
//
// ext-apps v1.7.4 `App.connect()` ONLY speaks the MCP postMessage protocol
// (OpenAI auto-detection is "not yet available"). So we cannot rely on the App
// alone — if the host is OpenAI-style, the App handshake never completes and the
// widget spins forever. This bridge therefore:
//   1. Uses `window.openai` when present (reading the initial `toolOutput` and
//      listening for async `openai:set_globals` updates).
//   2. Falls back to the MCP `App` postMessage handshake.
//   3. If NEITHER delivers data within a few seconds, renders a visible
//      diagnostic into the page so failures are no longer an opaque spinner.
//
// It exposes a small `window.mcpHost` facade the widget HTML consumes:
//   window.mcpHost.onData(cb)          -> cb(data) when tool data arrives
//   window.mcpHost.getData()           -> latest data | null
//   window.mcpHost.markRendered()      -> widget calls this once it draws data
//   window.mcpHost.callTool(name,args) -> Promise<result>
//   window.mcpHost.sendFollowUp(text)  -> ask the model a follow-up prompt
//   window.mcpHost.openExternal(url)   -> open a URL in the host's browser
//   window.mcpHost.applyTheme()        -> sync <html data-theme> with host theme
//   window.mcpHost.diagnostics()       -> human-readable status string

import { App } from "@modelcontextprotocol/ext-apps";

type DataListener = (data: unknown) => void;

interface OpenAiGlobal {
  toolOutput?: unknown;
  toolInput?: unknown;
  theme?: string;
  displayMode?: string | { mode?: string; availableDisplayModes?: unknown };
  availableDisplayModes?: unknown;
  callTool?: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  sendFollowUpMessage?: (args: { prompt: string }) => unknown;
  openExternal?: (args: { href: string }) => unknown;
  requestDisplayMode?: (args: { mode: DisplayMode }) => Promise<{ mode?: string } | string>;
}

type DisplayMode = "inline" | "fullscreen" | "pip";

interface McpHost {
  onData(cb: DataListener): void;
  getData(): unknown;
  markRendered(): void;
  applyTheme(): void;
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
  sendFollowUp(text: string): Promise<unknown> | void;
  openExternal(url: string): boolean;
  requestDisplayMode(mode: DisplayMode): Promise<{ mode: string }>;
  getDisplayMode(): string;
  getAvailableDisplayModes(): string[];
  diagnostics(): string;
  readonly theme: string;
}

declare global {
  interface Window {
    mcpHost?: McpHost;
    openai?: OpenAiGlobal;
    __mcpRendered?: boolean;
  }
}

(function bootstrapMcpHost(): void {
  const listeners: DataListener[] = [];
  let current: unknown = null;
  const status = {
    openai: false,
    mcpApp: false,
    mcpConnected: false,
    mcpError: "",
    dataSource: "none",
    dataReceived: false
  };

  function unwrap(result: unknown): unknown {
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      if (r.structuredContent !== undefined) return r.structuredContent;
    }
    return result;
  }

  function emit(data: unknown, source: string): void {
    if (data === null || data === undefined) return;
    current = data;
    status.dataReceived = true;
    status.dataSource = source;
    for (const cb of listeners.slice()) {
      try {
        cb(current);
      } catch {
        /* a faulty widget listener must not break the bridge */
      }
    }
  }

  function applyTheme(theme?: string): void {
    if (theme === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    } else if (theme === "light") {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  function normalizeDisplayMode(mode: unknown): string | undefined {
    if (mode === "inline" || mode === "fullscreen" || mode === "pip") return mode;
    return undefined;
  }

  function normalizeAvailableDisplayModes(modes: unknown): string[] {
    if (!Array.isArray(modes)) return [];
    return modes.filter((mode): mode is string => normalizeDisplayMode(mode) !== undefined);
  }

  function getOpenAiDisplayModeContext(globals?: OpenAiGlobal): { mode?: string; availableDisplayModes: string[] } {
    if (!globals) return { mode: undefined, availableDisplayModes: [] };
    const fromDisplayMode =
      globals.displayMode && typeof globals.displayMode === "object"
        ? globals.displayMode
        : undefined;
    const modeCandidate = typeof globals.displayMode === "string" ? globals.displayMode : fromDisplayMode?.mode;
    const availableCandidate =
      globals.availableDisplayModes !== undefined ? globals.availableDisplayModes : fromDisplayMode?.availableDisplayModes;
    return {
      mode: normalizeDisplayMode(modeCandidate),
      availableDisplayModes: normalizeAvailableDisplayModes(availableCandidate)
    };
  }

  function getMcpDisplayModeContext(): { mode?: string; availableDisplayModes: string[] } {
    const ctx = app && app.getHostContext ? app.getHostContext() : undefined;
    return {
      mode: normalizeDisplayMode(ctx && typeof ctx.displayMode === "string" ? ctx.displayMode : undefined),
      availableDisplayModes: normalizeAvailableDisplayModes(ctx && typeof ctx === "object" ? ctx.availableDisplayModes : undefined)
    };
  }

  // --- Path A: OpenAI Apps SDK (window.openai) ------------------------------
  const oai = typeof window !== "undefined" ? window.openai : undefined;
  let latestOpenAiGlobals: OpenAiGlobal | undefined = oai;
  if (oai) {
    status.openai = true;
    applyTheme(oai.theme);
    if (oai.toolOutput !== undefined && oai.toolOutput !== null) {
      emit(oai.toolOutput, "openai:initial");
    }
    // Async updates (toolOutput, theme, …) arrive via this DOM event.
    window.addEventListener("openai:set_globals", (ev: Event) => {
      const detail = ((ev as CustomEvent).detail || {}) as Record<string, unknown>;
      const globals = (detail.globals || detail) as OpenAiGlobal;
      latestOpenAiGlobals = { ...(latestOpenAiGlobals || {}), ...globals };
      if (globals.theme) applyTheme(globals.theme);
      if (globals.toolOutput !== undefined && globals.toolOutput !== null) {
        emit(globals.toolOutput, "openai:set_globals");
      }
    });
  }

  // --- Path B: MCP Apps (ext-apps App postMessage handshake) ----------------
  let app: App | null = null;
  try {
    app = new App({ name: "servicenow-mcp-widget", version: "1.0.0" }, {});
    status.mcpApp = true;
    app.ontoolresult = (params: unknown) => emit(unwrap(params), "mcp:tool-result");
    app.onhostcontextchanged = (ctx: unknown) => {
      const theme = ctx && typeof ctx === "object" ? (ctx as Record<string, unknown>).theme : undefined;
      if (typeof theme === "string") applyTheme(theme);
    };
    // connect() with no arg uses the default PostMessageTransport(window.parent).
    app
      .connect()
      .then(() => {
        status.mcpConnected = true;
        const ctx = app && app.getHostContext ? app.getHostContext() : undefined;
        const theme = ctx && typeof ctx.theme === "string" ? ctx.theme : undefined;
        if (theme) applyTheme(theme);
      })
      .catch((err: unknown) => {
        status.mcpError = err instanceof Error ? err.message : String(err);
      });
  } catch (err) {
    status.mcpError = err instanceof Error ? err.message : String(err);
  }

  function diagnostics(): string {
    return [
      "ServiceNow widget bridge status:",
      `• window.openai present: ${status.openai}`,
      `• MCP App created: ${status.mcpApp}`,
      `• MCP App connected: ${status.mcpConnected}`,
      status.mcpError ? `• MCP App error: ${status.mcpError}` : "",
      `• data received: ${status.dataReceived} (source: ${status.dataSource})`
    ]
      .filter(Boolean)
      .join("\n");
  }

  function currentTheme(): string | undefined {
    if (latestOpenAiGlobals && typeof latestOpenAiGlobals.theme === "string") return latestOpenAiGlobals.theme;
    const ctx = app && app.getHostContext ? app.getHostContext() : undefined;
    return ctx && typeof ctx.theme === "string" ? ctx.theme : undefined;
  }

  function currentDisplayMode(): string {
    const openAiContext = getOpenAiDisplayModeContext(latestOpenAiGlobals);
    if (openAiContext.mode) return openAiContext.mode;
    return getMcpDisplayModeContext().mode || "inline";
  }

  function availableDisplayModes(): string[] {
    const openAiContext = getOpenAiDisplayModeContext(latestOpenAiGlobals);
    if (openAiContext.availableDisplayModes.length > 0) return openAiContext.availableDisplayModes;
    return getMcpDisplayModeContext().availableDisplayModes;
  }

  const host: McpHost = {
    onData(cb: DataListener): void {
      listeners.push(cb);
      if (current !== null) {
        try {
          cb(current);
        } catch {
          /* ignore */
        }
      }
    },
    getData(): unknown {
      return current;
    },
    markRendered(): void {
      window.__mcpRendered = true;
    },
    applyTheme(): void {
      applyTheme(currentTheme());
    },
    callTool(name: string, args?: Record<string, unknown>): Promise<unknown> {
      if (oai && typeof oai.callTool === "function") {
        return Promise.resolve(oai.callTool(name, args || {}));
      }
      if (app) {
        return app.callServerTool({ name, arguments: args || {} });
      }
      return Promise.reject(new Error("No host bridge available to call tools."));
    },
    sendFollowUp(text: string): Promise<unknown> | void {
      if (oai && typeof oai.sendFollowUpMessage === "function") {
        return Promise.resolve(oai.sendFollowUpMessage({ prompt: text }));
      }
      if (app) {
        return app.sendMessage({ role: "user", content: [{ type: "text", text }] });
      }
    },
    // Open an external URL through the HOST, not the sandboxed iframe. A plain
    // <a target="_blank"> (or window.open) is blocked by the widget sandbox in
    // Microsoft 365 Copilot, so we route through the documented host bridge:
    //   • OpenAI Apps SDK  -> window.openai.openExternal({ href })
    //   • MCP Apps         -> app.openLink({ url })  (ui/open-link)
    // Returns true if a host bridge handled it; the caller can fall back to a
    // window.open() only as a last resort (e.g. local/standalone testing).
    openExternal(url: string): boolean {
      if (!url) return false;
      try {
        if (oai && typeof (oai as { openExternal?: unknown }).openExternal === "function") {
          (oai as { openExternal: (a: { href: string }) => unknown }).openExternal({ href: url });
          return true;
        }
      } catch {
        /* fall through to the App bridge */
      }
      try {
        const a = app as unknown as { openLink?: (a: { url: string }) => unknown } | null;
        if (a && typeof a.openLink === "function") {
          a.openLink({ url });
          return true;
        }
      } catch {
        /* fall through to window.open */
      }
      return false;
    },
    requestDisplayMode(mode: DisplayMode): Promise<{ mode: string }> {
      if (oai && typeof oai.requestDisplayMode === "function") {
        return Promise.resolve(oai.requestDisplayMode({ mode })).then(result => ({
          mode:
            normalizeDisplayMode(
              result && typeof result === "object" ? (result as { mode?: unknown }).mode : result
            ) || mode
        }));
      }
      if (app && typeof (app as unknown as { requestDisplayMode?: unknown }).requestDisplayMode === "function") {
        const request = (app as unknown as { requestDisplayMode: (a: { mode: DisplayMode }) => Promise<{ mode?: string } | string> })
          .requestDisplayMode;
        return Promise.resolve(request({ mode })).then(result => ({
          mode:
            normalizeDisplayMode(
              result && typeof result === "object" ? (result as { mode?: unknown }).mode : result
            ) || mode
        }));
      }
      return Promise.reject(new Error("Host does not support display mode requests."));
    },
    getDisplayMode(): string {
      return currentDisplayMode();
    },
    getAvailableDisplayModes(): string[] {
      return availableDisplayModes();
    },
    diagnostics,
    get theme(): string {
      return currentTheme() || "light";
    }
  };

  window.mcpHost = host;

  // --- Self-diagnostic: if nothing rendered after a few seconds, surface why.
  window.setTimeout(() => {
    if (window.__mcpRendered || status.dataReceived) return;
    const root = document.getElementById("root") || document.body;
    if (!root) return;
    root.innerHTML = "";
    const pre = document.createElement("pre");
    pre.style.cssText =
      "white-space:pre-wrap;font:12px/1.5 'Segoe UI',system-ui,sans-serif;color:#b00020;padding:12px;margin:0;";
    pre.textContent =
      "The ServiceNow widget could not load its data.\n\n" +
      diagnostics() +
      "\n\nThis message is shown by the widget itself for diagnostics.";
    root.appendChild(pre);
  }, 5000);
})();
