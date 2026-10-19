/**
 * Pieces of the `effect/cli` `Environment` for a host with no TTY (Raycast).
 */
import { Effect, FileSystem, Layer, Path, Schema, Stdio, Terminal } from "effect"
import { ChildProcessSpawner } from "effect/process"

/** Raised as a defect: `Terminal` has no error channel for "this host cannot prompt". */
export class InteractivePromptError extends Schema.TaggedError<InteractivePromptError>()("InteractivePromptError", {}) {
  override get message() {
    return "Interactive terminal prompts are not available in Raycast. Provide the value in the form instead."
  }
}

export class SpawnDisabledError extends Schema.TaggedError<SpawnDisabledError>()("SpawnDisabledError", {}) {
  override get message() {
    return "Process spawning is disabled while reflecting the CLI"
  }
}

/** What help/usage rendering assumes when there is no real terminal to measure. */
const COLUMNS = 100
const ROWS = 40

/** A terminal that renders nothing and refuses to prompt. */
export const terminal: Terminal.Terminal = Terminal.make({
  columns: Effect.succeed(COLUMNS),
  rows: Effect.succeed(ROWS),
  readInput: Effect.die(new InteractivePromptError()),
  readLine: Effect.die(new InteractivePromptError()),
  display: () => Effect.void
})

/** Inert environment used while reflecting (resolving default values). */
export const reflectionLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(Terminal.Terminal, terminal),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die(new SpawnDisabledError()))
  )
)
