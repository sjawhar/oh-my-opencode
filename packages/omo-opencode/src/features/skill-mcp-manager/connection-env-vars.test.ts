import { afterAll, afterEach, beforeEach, describe, expect, it, mock, test } from "bun:test"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { ClaudeCodeMcpServer } from "../claude-code-mcp-loader/types"
import type { SkillMcpClientInfo, SkillMcpManagerState } from "./types"
import { setHttpClientDependenciesForTesting } from "./http-client"
import { setStdioClientDependenciesForTesting } from "./stdio-client"

const trackedStates: SkillMcpManagerState[] = []
const createdStdioTransports: MockStdioClientTransport[] = []
const createdHttpTransports: MockStreamableHTTPClientTransport[] = []

class MockClient {
  readonly close = mock(async () => {})
  readonly listTools = mock(async () => ({ tools: [] }))
  readonly listResources = mock(async () => ({ resources: [] }))
  readonly listPrompts = mock(async () => ({ prompts: [] }))
  readonly callTool = mock(async () => ({ content: [] }))
  readonly readResource = mock(async () => ({ contents: [] }))
  readonly getPrompt = mock(async () => ({ messages: [] }))

  constructor(
    _clientInfo: { name: string; version: string },
    _options: { capabilities: Record<string, never> }
  ) {}

  async connect(_transport: Transport): Promise<void> {
    // Successful connect, env-related assertions happen on transport constructor args
  }
}

class MockStdioClientTransport {
  readonly close = mock(async () => {})
  readonly start = mock(async () => {})
  readonly send = mock(async () => {})
  readonly options: StdioServerParameters

  constructor(options: StdioServerParameters) {
    this.options = options
    createdStdioTransports.push(this)
  }
}

interface MockHttpTransportOptions {
  requestInit?: RequestInit
}

function getHeaderValue(
  headers: HeadersInit | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined
  }

  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined
  }

  if (Array.isArray(headers)) {
    const entry = headers.find(([headerName]) => headerName.toLowerCase() === name.toLowerCase())
    return entry?.[1]
  }

  return headers[name]
}

class MockStreamableHTTPClientTransport {
  readonly close = mock(async () => {})
  readonly send = mock(async () => {})
  readonly url: URL
  readonly options?: MockHttpTransportOptions

  constructor(url: URL, options?: MockHttpTransportOptions) {
    this.url = url
    this.options = options
    createdHttpTransports.push(this)
  }

  async start() {}
}

afterAll(() => {
  mock.restore()
})

const { disconnectAll } = await import("./cleanup")
const { getOrCreateClient } = await import("./connection")

function createState(): SkillMcpManagerState {
  const state: SkillMcpManagerState = {
    clients: new Map(),
    pendingConnections: new Map(),
    disconnectedSessions: new Map(),
    authProviders: new Map(),
    cleanupRegistered: false,
    cleanupInterval: null,
    cleanupHandlers: [],
    idleTimeoutMs: 5 * 60 * 1000,
    shutdownGeneration: 0,
    inFlightConnections: new Map(),
    disposed: false,
    createOAuthProvider: () => ({
      tokens: () => null,
      login: async () => ({ accessToken: "test-token" }),
      refresh: async () => ({ accessToken: "test-token" }),
    }),
  }
  trackedStates.push(state)
  return state
}

function createClientInfo(
  serverName: string,
  scope?: SkillMcpClientInfo["scope"],
): SkillMcpClientInfo {
  return {
    serverName,
    skillName: "env-skill",
    sessionID: "session-env",
    ...(scope !== undefined ? { scope } : {}),
  }
}

function createClientKey(info: SkillMcpClientInfo): string {
  return `${info.sessionID}:${info.skillName}:${info.serverName}`
}

beforeEach(() => {
  createdStdioTransports.length = 0
  createdHttpTransports.length = 0
  setStdioClientDependenciesForTesting({
    createClient: (clientInfo, options) => new MockClient(clientInfo, options),
    createTransport: (options) => new MockStdioClientTransport(options),
  })
  setHttpClientDependenciesForTesting({
    createClient: (clientInfo, options) => new MockClient(clientInfo, options),
    createTransport: (url, options) => new MockStreamableHTTPClientTransport(url, options),
  })
})

afterEach(async () => {
  for (const state of trackedStates) {
    await disconnectAll(state)
  }
  trackedStates.length = 0

  setStdioClientDependenciesForTesting()
  setHttpClientDependenciesForTesting()
})

describe("getOrCreateClient env var expansion", () => {
  describe("#given a scope-sensitive stdio skill MCP config", () => {
    test.each([
      ["opencode-project", "Authorization:Bearer "],
      ["local", "Authorization:Bearer "],
      ["user", "Authorization:Bearer xoxp-scope-token"],
      ["builtin", "Authorization:Bearer xoxp-scope-token"],
    ] satisfies Array<[NonNullable<SkillMcpClientInfo["scope"]>, string]>) (
      "#when creating the client for %s scope #then args expand to %s",
      async (scope, expectedAuthorizationHeader) => {
        // given
        process.env.SLACK_USER_TOKEN = "xoxp-scope-token"
        const state = createState()
        const info = createClientInfo(`scope-${scope}`, scope)
        const clientKey = createClientKey(info)
        const config: ClaudeCodeMcpServer = {
          command: "npx",
          args: [
            "-y",
            "mcp-remote",
            "https://mcp.slack.com/mcp",
            "--header",
            "Authorization:Bearer ${SLACK_USER_TOKEN}",
          ],
        }

        // when
        await getOrCreateClient({ state, clientKey, info, config })

        // then
        expect(createdStdioTransports).toHaveLength(1)
        expect(createdStdioTransports[0]?.options.args?.[4]).toBe(expectedAuthorizationHeader)
      },
    )

    it("#when creating the client without scope #then env vars remain trusted for backward compatibility", async () => {
      // given
      process.env.SLACK_USER_TOKEN = "xoxp-undefined-scope-token"
      const state = createState()
      const info = createClientInfo("scope-undefined")
      const clientKey = createClientKey(info)
      const config: ClaudeCodeMcpServer = {
        command: "npx",
        args: [
          "-y",
          "mcp-remote",
          "https://mcp.slack.com/mcp",
          "--header",
          "Authorization:Bearer ${SLACK_USER_TOKEN}",
        ],
      }

      // when
      await getOrCreateClient({ state, clientKey, info, config })

      // then
      expect(createdStdioTransports).toHaveLength(1)
      expect(createdStdioTransports[0]?.options.args?.[4]).toBe(
        "Authorization:Bearer xoxp-undefined-scope-token",
      )
    })
  })

  describe("#given a stdio skill MCP config with sensitive env vars in args", () => {
    it("#when creating the client #then sensitive env vars in args are expanded", async () => {
      // given
      process.env.SLACK_USER_TOKEN = "xoxp-secret-token"
      const state = createState()
      const info = createClientInfo("slack-stdio")
      const clientKey = createClientKey(info)
      const config: ClaudeCodeMcpServer = {
        command: "npx",
        args: [
          "-y",
          "mcp-remote",
          "https://mcp.slack.com/mcp",
          "--header",
          "Authorization:Bearer ${SLACK_USER_TOKEN}",
        ],
      }

      // when
      await getOrCreateClient({ state, clientKey, info, config })

      // then
      expect(createdStdioTransports).toHaveLength(1)
      expect(createdStdioTransports[0]?.options.args).toEqual([
        "-y",
        "mcp-remote",
        "https://mcp.slack.com/mcp",
        "--header",
        "Authorization:Bearer xoxp-secret-token",
      ])
    })
  })

  describe("#given a stdio skill MCP config with sensitive env vars in env map", () => {
    it("#when creating the client #then sensitive env vars in env map are expanded", async () => {
      // given
      process.env.MY_SLACK_USER_TOKEN_VALUE = "token-123"
      const state = createState()
      const info = createClientInfo("env-stdio")
      const clientKey = createClientKey(info)
      const config: ClaudeCodeMcpServer = {
        command: "node",
        args: ["server.js"],
        env: {
          SLACK_BOT_USER_ID: "${MY_SLACK_USER_TOKEN_VALUE}",
        },
      }

      // when
      await getOrCreateClient({ state, clientKey, info, config })

      // then
      expect(createdStdioTransports).toHaveLength(1)
      expect(createdStdioTransports[0]?.options.env?.SLACK_BOT_USER_ID).toBe("token-123")
    })
  })

  describe("#given an http skill MCP config with sensitive env vars in headers", () => {
    it("#when creating the client #then sensitive env vars in headers are expanded", async () => {
      // given
      process.env.SLACK_USER_TOKEN = "xoxp-http-secret"
      const state = createState()
      const info = createClientInfo("slack-http")
      const clientKey = createClientKey(info)
      const config: ClaudeCodeMcpServer = {
        url: "https://mcp.slack.com/mcp",
        headers: {
          Authorization: "Bearer ${SLACK_USER_TOKEN}",
        },
      }

      // when
      await getOrCreateClient({ state, clientKey, info, config })

        // then
        expect(createdHttpTransports).toHaveLength(1)
        expect(getHeaderValue(createdHttpTransports[0]?.options?.requestInit?.headers, "Authorization")).toBe(
          "Bearer xoxp-http-secret"
        )
      })
  })
})

describe("createStdioClient session env", () => {
  describe("#given a harness that can resolve the session's child environment", () => {
    it("#when creating the client #then the child receives it", async () => {
      // given
      const state = createState()
      state.resolveSessionEnv = async (sessionID: string) => ({
        SECRETSD_SESSION_TOKEN_FILE: `/run/secretsd/${sessionID}.token`,
      })
      const info = createClientInfo("session-env")
      const clientKey = createClientKey(info)
      const config: ClaudeCodeMcpServer = {
        command: "node",
        args: ["server.js"],
      }

      // when
      await getOrCreateClient({ state, clientKey, info, config })

      // then
      expect(createdStdioTransports).toHaveLength(1)
      expect(createdStdioTransports[0]?.options.env?.SECRETSD_SESSION_TOKEN_FILE).toBe(
        "/run/secretsd/session-env.token"
      )
    })
  })

  describe("#given a declared entry that collides with the resolved session env", () => {
    it("#when creating the client #then the declared entry wins", async () => {
      // given
      const state = createState()
      state.resolveSessionEnv = async () => ({ SHARED_KEY: "from-session" })
      const info = createClientInfo("session-env-override")
      const clientKey = createClientKey(info)
      const config: ClaudeCodeMcpServer = {
        command: "node",
        args: ["server.js"],
        env: { SHARED_KEY: "from-skill" },
      }

      // when
      await getOrCreateClient({ state, clientKey, info, config })

      // then
      expect(createdStdioTransports[0]?.options.env?.SHARED_KEY).toBe("from-skill")
    })
  })

  describe("#given a harness too old to resolve a session's child environment", () => {
    it("#when creating the client #then the spawn still succeeds", async () => {
      // given
      const state = createState()
      const info = createClientInfo("session-env-absent")
      const clientKey = createClientKey(info)
      const config: ClaudeCodeMcpServer = {
        command: "node",
        args: ["server.js"],
      }

      // when
      await getOrCreateClient({ state, clientKey, info, config })

      // then
      // Asserted on a name no ambient environment carries: this runner inherits a
      // real session token, so a realistic name would pass without the resolver.
      expect(createdStdioTransports).toHaveLength(1)
      expect(createdStdioTransports[0]?.options.env?.OMO_SESSION_ENV_PROBE).toBeUndefined()
      // Ambient inheritance still happened. Asserted on the entry count rather
      // than a named variable: Windows spells PATH as Path, so any specific
      // name makes this platform-dependent.
      expect(Object.keys(createdStdioTransports[0]?.options.env ?? {}).length).toBeGreaterThan(0)
    })
  })
})
