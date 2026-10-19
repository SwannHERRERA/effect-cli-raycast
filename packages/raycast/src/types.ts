import { Argv, type Config, Field, Runner, Spec } from "@effect-cli-raycast/core"
import type { Form, Keyboard } from "@raycast/api"
import { type Effect, type ManagedRuntime, Option, Schema, String as Str } from "effect"
import type { ReactNode } from "react"
import type { History } from "./history.ts"
import type { Raycast } from "./Raycast.ts"

/** What every screen and run needs from the runtime. */
export type Services = History | Raycast

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

/** What started a run; it decides confirmation, feedback and whether a view may be pushed. */
export const Trigger = Schema.TaggedUnion({
  /** Submitted from a form: may push the result view. */
  Form: {},
  /** A `no-view` command: no view to push. */
  NoView: {},
  /** "Run Again" on a result already confirmed once. */
  Rerun: {},
  /** `app.run` / AI tools: no UI at all. */
  Api: {}
})
export type Trigger = typeof Trigger.Type

export const Triggers = {
  Form: Trigger.cases.Form.make({}),
  NoView: Trigger.cases.NoView.make({}),
  Rerun: Trigger.cases.Rerun.make({}),
  Api: Trigger.cases.Api.make({})
} as const

export const ResultContext = Schema.Struct({
  leaf: Spec.LeafSpec,
  values: Field.FieldValues,
  argv: Schema.Array(Argv.Arg),
  /** Redacted, shell-quoted command line. */
  commandLine: Schema.String,
  result: Runner.RunResult
})
export interface ResultContext extends Schema.Schema.Type<typeof ResultContext> {}

/** How a completed run is presented: the caller pushes the detail view, or the output was already delivered. */
export const Outcome = Schema.TaggedUnion({
  ShowDetail: { context: ResultContext },
  Delivered: { context: ResultContext }
})
export type Outcome = typeof Outcome.Type

/** `run` submits as soon as the form is ready (launch arguments covered every required field). */
export const LaunchMode = Schema.Literals(["edit", "run"])
export type LaunchMode = typeof LaunchMode.Type

/** Shortcuts shared by every screen, so the same keys always mean the same thing. */
export const Shortcuts = {
  copyCommandLine: { modifiers: ["cmd", "shift"], key: "l" },
  copyOutput: { modifiers: ["cmd", "shift"], key: "c" },
  copyStderr: { modifiers: ["cmd", "opt"], key: "c" },
  runAgain: { modifiers: ["cmd"], key: "r" }
} as const satisfies Record<string, Keyboard.Shortcut>

export class UnknownCommand extends Schema.TaggedError<UnknownCommand>()("UnknownCommand", {
  root: Schema.String,
  path: Schema.String
}) {
  override get message() {
    return `Unknown command "${this.path}" in ${this.root}`
  }
}

export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  errors: Field.FieldErrors
}) {
  override get message() {
    return Object.entries(this.errors)
      .map(([id, error]) => `${id}: ${error}`)
      .join("\n")
  }
}

export class Cancelled extends Schema.TaggedError<Cancelled>()("Cancelled", {}) {}

export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  result: Runner.RunResult
}) {
  override get message() {
    return Option.liftPredicate(this.result.stderr, Str.isNonEmpty).pipe(
      Option.orElse(() => Option.liftPredicate(this.result.stdout, Str.isNonEmpty)),
      Option.getOrElse(() => `exit ${this.result.exitCode}`)
    )
  }
}

/* -------------------------------------------------------------------------- */
/* Fields                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Props shared by every generated form item; spread `item` onto any `Form.*`
 * component. Shaped like Raycast's own props, so optional values stay optional.
 */
export interface FieldItemProps {
  readonly id: Spec.ParamId
  readonly title: string
  readonly info?: string
  readonly error?: string
  readonly placeholder?: string
  readonly storeValue: boolean
  readonly autoFocus: boolean
  readonly onChange: (value: Form.Value) => void
  readonly onBlur: (event: Form.Event<Form.Value>) => void
}

export interface FieldProps<W extends Field.Widget = Field.Widget> {
  readonly param: Spec.ParamSpec
  readonly override: Config.FieldOverride
  readonly widget: W
  readonly item: FieldItemProps
  /** Initial value in the widget's native type. */
  readonly defaultValue: Field.WidgetValues[W]
}

export type FieldRenderer<W extends Field.Widget = Field.Widget> = (props: FieldProps<W>) => ReactNode

export type WidgetRenderers = { readonly [W in Field.Widget]: FieldRenderer<W> }

/* -------------------------------------------------------------------------- */
/* Extension points                                                           */
/* -------------------------------------------------------------------------- */

export interface UiOptions {
  /** Replace the widget used for a whole widget kind. */
  readonly widgets?: Partial<WidgetRenderers>
  /** Replace the widget of one field, keyed by `ParamSpec.id` or bare param name. */
  readonly fields?: Readonly<Record<string, FieldRenderer>>
  /** Custom result screen (replaces the default `Detail`). */
  readonly renderResult?: (context: ResultContext) => ReactNode
  /** Custom markdown for the default result screen. */
  readonly formatOutput?: (context: ResultContext) => string
  /** Extra actions appended to every form's action panel. */
  readonly formActions?: (leaf: Spec.LeafSpec) => ReactNode
  /** Side effect after each run (analytics, notifications, …); failures are logged, never shown. */
  readonly onResult?: (context: ResultContext) => Effect.Effect<void, unknown>
}

/** Everything a screen needs once the config is resolved. */
export interface Session {
  readonly config: Config.RaycastConfig
  readonly ui: UiOptions
  readonly runtime: ManagedRuntime.ManagedRuntime<Services, never>
}
