/**
 * Raycast metadata that a CLI author can attach next to the command definition:
 *
 * ```ts
 * deploy.pipe(Command.annotate(Raycast.Meta, { icon: "rocket.png", confirm: true }))
 * ```
 */
import { Context, Option, Schema } from "effect"

export const Mode = Schema.Literals(["view", "no-view"])
export type Mode = typeof Mode.Type

export const RaycastMeta = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  subtitle: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  icon: Schema.optionalKey(Schema.String),
  keywords: Schema.optionalKey(Schema.Array(Schema.String)),
  /** `no-view` runs immediately using Raycast arguments only (no form). */
  mode: Schema.optionalKey(Mode),
  /**
   * Ask for confirmation (`confirmAlert`) before running: `true` uses a default
   * prompt, a string is the prompt, `false` opts out of `feedback.confirm`.
   */
  confirm: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String])),
  /** Force a parent command (one with subcommands) to be treated as runnable. */
  runnable: Schema.optionalKey(Schema.Boolean),
  /** Skip this command (and its subtree) in the generated extension. */
  exclude: Schema.optionalKey(Schema.Boolean),
  /** Emit the command as a Raycast AI tool. */
  tool: Schema.optionalKey(Schema.Boolean)
})
export interface RaycastMeta extends Schema.Schema.Type<typeof RaycastMeta> {}

export class Meta extends Context.Service<Meta, RaycastMeta>()("effect-cli-raycast/Meta") {}

const empty: RaycastMeta = {}

export const get = (annotations: Context.Context<never>): RaycastMeta =>
  Context.getOption(annotations, Meta).pipe(Option.getOrElse(() => empty))
