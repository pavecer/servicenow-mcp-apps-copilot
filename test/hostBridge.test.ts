import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { appCtor } = vi.hoisted(() => ({ appCtor: vi.fn() }));

vi.mock("@modelcontextprotocol/ext-apps", () => ({ App: appCtor }));

type MockApp = {
  ontoolresult?: (params: unknown) => void;
  onhostcontextchanged?: (ctx: unknown) => void;
  connect: ReturnType<typeof vi.fn>;
  getHostContext: ReturnType<typeof vi.fn>;
  requestDisplayMode?: ReturnType<typeof vi.fn>;
};

function createMockApp(overrides: Partial<MockApp> = {}): MockApp {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    getHostContext: vi.fn(() => ({ theme: "light", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] })),
    requestDisplayMode: vi.fn().mockResolvedValue({ mode: "fullscreen" }),
    ...overrides
  };
}

async function loadBridge(options: { openai?: Record<string, unknown>; app?: MockApp } = {}) {
  vi.resetModules();
  const listeners = new Map<string, Array<(event: Event) => void>>();
  const documentElement = {
    attrs: new Map<string, string>(),
    setAttribute(name: string, value: string) { this.attrs.set(name, value); },
    removeAttribute(name: string) { this.attrs.delete(name); }
  };
  const document = {
    documentElement,
    body: { innerHTML: "", appendChild: vi.fn() },
    createElement: vi.fn(() => ({ style: {}, textContent: "" })),
    getElementById: vi.fn(() => null)
  };
  const window = {
    openai: options.openai,
    addEventListener: (name: string, listener: (event: Event) => void) => {
      listeners.set(name, [...(listeners.get(name) || []), listener]);
    },
    setTimeout: vi.fn(),
    mcpHost: undefined,
    __mcpRendered: false
  };

  appCtor.mockImplementation(function MockAppCtor() {
    return options.app || createMockApp();
  });
  (globalThis as { window?: unknown; document?: unknown }).window = window;
  (globalThis as { window?: unknown; document?: unknown }).document = document;

  await import("../src/ui/widgets/bridge/host-bridge");
  return window as {
    mcpHost: {
      getAvailableDisplayModes: () => string[];
      requestDisplayMode: (mode: "inline" | "fullscreen" | "pip") => Promise<{ mode: string }>;
    };
  };
}

describe("MCP host bridge display modes", () => {
  beforeEach(() => {
    appCtor.mockReset();
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown; document?: unknown }).window;
    delete (globalThis as { window?: unknown; document?: unknown }).document;
    vi.restoreAllMocks();
  });

  it("uses MCP App requestDisplayMode when OpenAI bridge is absent", async () => {
    const app = createMockApp();
    const window = await loadBridge({ app });

    expect(window.mcpHost.getAvailableDisplayModes()).toContain("fullscreen");
    await expect(window.mcpHost.requestDisplayMode("fullscreen")).resolves.toEqual({ mode: "fullscreen" });
    expect(app.requestDisplayMode).toHaveBeenCalledWith({ mode: "fullscreen" });
  });

  it("prefers OpenAI requestDisplayMode when available", async () => {
    const openAiRequestDisplayMode = vi.fn().mockResolvedValue({ mode: "fullscreen" });
    const app = createMockApp({ requestDisplayMode: vi.fn().mockResolvedValue({ mode: "inline" }) });
    const window = await loadBridge({
      app,
      openai: {
        theme: "light",
        displayMode: { mode: "inline", availableDisplayModes: ["inline", "fullscreen"] },
        requestDisplayMode: openAiRequestDisplayMode
      }
    });

    expect(window.mcpHost.getAvailableDisplayModes()).toEqual(["inline", "fullscreen"]);
    await expect(window.mcpHost.requestDisplayMode("fullscreen")).resolves.toEqual({ mode: "fullscreen" });
    expect(openAiRequestDisplayMode).toHaveBeenCalledWith({ mode: "fullscreen" });
    expect(app.requestDisplayMode).not.toHaveBeenCalled();
  });

  it("rejects gracefully when host display mode requests are unsupported", async () => {
    const app = createMockApp({ requestDisplayMode: undefined, getHostContext: vi.fn(() => ({ theme: "light", displayMode: "inline" })) });
    const window = await loadBridge({ app, openai: { theme: "light", displayMode: "inline" } });

    await expect(window.mcpHost.requestDisplayMode("fullscreen")).rejects.toThrow(
      "Host does not support display mode requests."
    );
  });

  it("times out display mode requests when the host never responds", async () => {
    vi.useFakeTimers();
    try {
      const app = createMockApp({ requestDisplayMode: vi.fn(() => new Promise(() => {})) });
      const window = await loadBridge({ app, openai: { theme: "light", displayMode: "inline" } });
      const pending = window.mcpHost.requestDisplayMode("fullscreen");
      const rejection = expect(pending).rejects.toThrow("Display mode request timed out.");

      await vi.advanceTimersByTimeAsync(5000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
