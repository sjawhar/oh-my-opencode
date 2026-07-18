import { enforceMainPaneWidth as enforceMainPaneWidthCore } from "@oh-my-opencode/tmux-core"
import type { MainPaneWidthOptions } from "@oh-my-opencode/tmux-core"
import type { TmuxLayout } from "../../../config/schema"

type TmuxSpawnCommand = (
	args: string[],
	options: { stdout: "ignore"; stderr: "ignore" },
) => { exited: Promise<number> }

interface LayoutDeps {
	spawnCommand?: TmuxSpawnCommand
	targetPaneId?: string
}

export async function applyLayout(
	tmux: string,
	layout: TmuxLayout,
	mainPaneSize: number,
	deps?: LayoutDeps,
): Promise<void> {
	const spawnCommand: TmuxSpawnCommand = deps?.spawnCommand ?? ((args) => ({
		exited: (async () => {
			const { runTmuxCommand } = await import("../runner")
			return (await runTmuxCommand(args[0] ?? "", args.slice(1))).exitCode
		})(),
	}))
	const targetArgs = deps?.targetPaneId ? ["-t", deps.targetPaneId] : []
	const layoutProc = spawnCommand([tmux, "select-layout", ...targetArgs, layout], {
		stdout: "ignore",
		stderr: "ignore",
	})
	await layoutProc.exited

	if (layout.startsWith("main-")) {
		const dimension =
			layout === "main-horizontal" ? "main-pane-height" : "main-pane-width"
		const sizeProc = spawnCommand(
			[tmux, "set-window-option", ...targetArgs, dimension, `${mainPaneSize}%`],
			{ stdout: "ignore", stderr: "ignore" },
		)
		await sizeProc.exited
	}
}

export async function enforceMainPaneWidth(
	mainPaneId: string,
	windowWidth: number,
	mainPaneSizeOrOptions?: number | MainPaneWidthOptions,
): Promise<void> {
  const [{ log }, { getTmuxPath }, { runTmuxCommand }] = await Promise.all([
    import("../../logger"),
    import("../../../tools/interactive-bash/tmux-path-resolver"),
    import("../runner"),
  ])
	return enforceMainPaneWidthCore(mainPaneId, windowWidth, mainPaneSizeOrOptions, {
    log,
    getTmuxPath,
    runTmuxCommand,
  })
}

export type { MainPaneWidthOptions }
