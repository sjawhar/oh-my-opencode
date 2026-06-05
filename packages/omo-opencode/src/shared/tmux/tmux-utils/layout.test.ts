import { afterEach, describe, expect, it, mock } from "bun:test"

const spawnCalls: string[][] = []
const spawnMock = mock((args: string[]) => {
  spawnCalls.push(args)
  return { exited: Promise.resolve(0) }
})

describe("applyLayout", () => {
  afterEach(() => {
    spawnCalls.length = 0
    spawnMock.mockClear()
  })

  it("applies main-vertical with main-pane-width option", async () => {
    const { applyLayout } = await import("./layout")

    await applyLayout("tmux", "main-vertical", 60, { spawnCommand: spawnMock })

    expect(spawnCalls).toEqual([
      ["tmux", "select-layout", "main-vertical"],
      ["tmux", "set-window-option", "main-pane-width", "60%"],
    ])
  })

  it("applies main-horizontal with main-pane-height option", async () => {
    const { applyLayout } = await import("./layout")

    await applyLayout("tmux", "main-horizontal", 55, { spawnCommand: spawnMock })

    expect(spawnCalls).toEqual([
      ["tmux", "select-layout", "main-horizontal"],
      ["tmux", "set-window-option", "main-pane-height", "55%"],
    ])
  })

  it("does not set main pane option for non-main layouts", async () => {
    const { applyLayout } = await import("./layout")

    await applyLayout("tmux", "tiled", 50, { spawnCommand: spawnMock })

    expect(spawnCalls).toEqual([["tmux", "select-layout", "tiled"]])
  })

  it("passes -t targetPaneId to select-layout and set-window-option when provided", async () => {
    const { applyLayout } = await import("./layout")

    await applyLayout("tmux", "main-vertical", 60, {
      spawnCommand: spawnMock,
      targetPaneId: "%5",
    })

    expect(spawnCalls).toEqual([
      ["tmux", "select-layout", "-t", "%5", "main-vertical"],
      ["tmux", "set-window-option", "-t", "%5", "main-pane-width", "60%"],
    ])
  })

  it("passes -t targetPaneId to select-layout for non-main layouts", async () => {
    const { applyLayout } = await import("./layout")

    await applyLayout("tmux", "tiled", 50, {
      spawnCommand: spawnMock,
      targetPaneId: "%3",
    })

    expect(spawnCalls).toEqual([["tmux", "select-layout", "-t", "%3", "tiled"]])
  })
})
