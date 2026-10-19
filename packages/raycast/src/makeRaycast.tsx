/**
 * `makeRaycast(config, ui)` returns the app value every generated stub imports:
 *
 * ```ts
 * // src/app.ts
 * export const app = makeRaycast(config, { widgets: { … } })
 * // src/deploy.tsx  (generated)
 * export default app.view("deploy")
 * ```
 *
 * Everything inside runs as `Effect`; the methods below are the only places
 * where an effect becomes what Raycast expects (a component, a promise).
 */
import { Argv, Config, type Field, type Introspect, Runner, Spec } from "@effect-cli-raycast/core"
import { Action, type Form, type LaunchProps, type Tool, Toast } from "@raycast/api"
import { Effect, Exit, Layer, ManagedRuntime, Match, Option, Schema } from "effect"
import type { ReactNode } from "react"
import { CommandBrowser } from "./CommandBrowser.tsx"
import { CommandForm, type FormSeed } from "./CommandForm.tsx"
import { ErrorScreen } from "./ErrorScreen.tsx"
import { execute } from "./execute.ts"
import * as History from "./history.ts"
import { useEffectState } from "./hooks.ts"
import * as Inputs from "./inputs.ts"
import { localStorageLayer, Raycast, layer as raycastLayer, type RaycastError } from "./Raycast.ts"
import {
  type Cancelled,
  CommandFailed,
  type InvalidInput,
  type Services,
  type Session,
  Triggers,
  type UiOptions,
  UnknownCommand
} from "./types.ts"
import { errorOf, RunState, useRunner } from "./useRunner.tsx"

/** What Raycast hands a command: launch arguments and saved form drafts. */
export const LaunchContext = Schema.Struct({
  arguments: Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String)),
  draftValues: Schema.Record(Schema.String, Schema.Unknown)
})
export interface LaunchContext extends Schema.Schema.Type<typeof LaunchContext> {}

const emptyLaunch: LaunchContext = { arguments: {}, draftValues: {} }

type Launch = LaunchProps<{ arguments: Record<string, string | undefined>; draftValues: Form.Values }>

/** Raycast passes partial props (no arguments, no drafts); anything unexpected counts as empty. */
const launchContextOf = (props: Launch): LaunchContext =>
  Schema.decodeUnknownOption(LaunchContext)({
    arguments: Option.getOrElse(Option.fromUndefinedOr(props.arguments), () => ({})),
    draftValues: Option.getOrElse(Option.fromUndefinedOr(props.draftValues), () => ({}))
  }).pipe(Option.getOrElse(() => emptyLaunch))

export type SetupError = Config.ConfigError | Introspect.IntrospectError

export type RunError = UnknownCommand | InvalidInput | Cancelled | RaycastError

export interface FormControls {
  readonly session: Session
  readonly leaf: Spec.LeafSpec
  /** The message for a field rejected by the last submission (pass to the item's `error`). */
  readonly errorOf: (id: string) => string | undefined
  /** Pass to `Action.SubmitForm`; resolves `false` when the values were rejected. */
  readonly submit: (values: Form.Values) => Promise<boolean>
  /** `true` while a run is in flight (pass to `Form`'s `isLoading`). */
  readonly isLoading: boolean
}

export interface RaycastApp {
  /** The resolved config, or why it could not be resolved. */
  readonly session: Exit.Exit<Session, SetupError>
  /** Leaf by path key without the root (`"db migrate"`, `""` for a single-command CLI). */
  readonly leaf: (path: string) => Effect.Effect<Spec.LeafSpec, SetupError | UnknownCommand>
  /** Raycast `view` command rendering the form for a leaf. */
  readonly view: (path: string) => (props: Launch) => ReactNode
  /** A hand-written form (see `ecr eject`) that reuses validation, run feedback, results and history. */
  readonly customView: (path: string, render: (form: FormControls) => ReactNode) => (props: Launch) => ReactNode
  /** Raycast `no-view` command: runs with launch arguments + defaults only. */
  readonly noView: (path: string) => (props: Launch) => Promise<void>
  /** Raycast `view` command listing every leaf plus recent runs. */
  readonly browser: () => () => ReactNode
  /** Run a leaf programmatically; input is keyed by camelCased param name, like an AI tool's. */
  readonly run: (
    path: string,
    input: Readonly<Record<string, unknown>>
  ) => Effect.Effect<Runner.RunResult, SetupError | RunError, Services>
  /** AI tool entry point: resolves to stdout, rejects on failure. */
  readonly tool: (path: string, input: Readonly<Record<string, unknown>>) => Promise<string>
  /** AI tool `confirmation` export: resolves `undefined` for commands that need no confirmation. */
  readonly confirmation: <I extends Readonly<Record<string, unknown>>>(path: string) => Tool.Confirmation<I>
}

/* -------------------------------------------------------------------------- */
/* Screens                                                                    */
/* -------------------------------------------------------------------------- */

const seedOf = (session: Session, leaf: Spec.LeafSpec, props: Launch): FormSeed => {
  const launch = launchContextOf(props)
  const explicit = Inputs.fromLaunchArguments(session, leaf, launch.arguments)
  return { explicit, drafts: launch.draftValues, launch: Inputs.launchOf(leaf, explicit) }
}

function CustomForm(props: {
  readonly session: Session
  readonly leaf: Spec.LeafSpec
  readonly seed: FormSeed
  readonly render: (form: FormControls) => ReactNode
}) {
  const { session, leaf, seed } = props
  const runner = useRunner(session)
  // Launch arguments that cover every required field run the command at once, as in a generated form.
  useEffectState(session, Spec.pathKey(leaf.command.path), () =>
    Match.value(seed.launch).pipe(
      Match.when("run", () => runner.submit(leaf, Inputs.fromTokens(leaf, seed.explicit))),
      Match.when("edit", () => Effect.void),
      Match.exhaustive
    )
  )
  return (
    <>
      {props.render({
        session,
        leaf,
        errorOf: (id) => Option.getOrUndefined(errorOf(runner.state, Spec.ParamId.make(id))),
        submit: (values) => session.runtime.runPromise(runner.submit(leaf, Inputs.fromForm(session, leaf, values))),
        isLoading: RunState.$is("Running")(runner.state)
      })}
    </>
  )
}

const failureToast = (error: { readonly message: string }) =>
  Raycast.use((raycast) =>
    raycast.toast({ style: Toast.Style.Failure, title: "Command not run", message: error.message })
  ).pipe(Effect.ignore)

/* -------------------------------------------------------------------------- */
/* App                                                                        */
/* -------------------------------------------------------------------------- */

const leafOf = (session: Session, path: string): Effect.Effect<Spec.LeafSpec, UnknownCommand> =>
  Spec.findLeaf(session.config.spec, Spec.pathOf(session.config.spec, path)).pipe(
    Effect.fromOption,
    Effect.mapError(() => new UnknownCommand({ root: session.config.spec.root.name, path }))
  )

function BrowseScreen(props: { readonly session: Exit.Exit<Session, SetupError> }) {
  return Exit.match(props.session, {
    onSuccess: (current) => <CommandBrowser session={current} />,
    onFailure: (cause) => <ErrorScreen title="effect-cli-raycast could not load the CLI" cause={cause} />
  })
}

const runtimeLayer = Layer.mergeAll(History.layer.pipe(Layer.provide(localStorageLayer)), raycastLayer)

export const makeRaycast = (config: Config.Definition, ui: UiOptions = {}): RaycastApp => {
  // Raycast evaluates a command's module per launch and unloads it afterwards,
  // so the runtime lives exactly as long as the command.
  const runtime = ManagedRuntime.make(runtimeLayer)
  const session: Exit.Exit<Session, SetupError> = Effect.runSyncExit(
    Effect.map(config.resolve, (resolved): Session => ({ config: resolved, ui, runtime }))
  )

  const Browser = () => <BrowseScreen session={session} />
  Browser.displayName = "Browse"

  const resolve = (path: string) =>
    Effect.flatMap(session, (current) => Effect.map(leafOf(current, path), (leaf) => ({ session: current, leaf })))

  /** Resolved once per entry point, not per render: the spec is plain data once the config is loaded. */
  const screen = (path: string, render: (session: Session, leaf: Spec.LeafSpec, props: Launch) => ReactNode) => {
    const resolved = Effect.runSyncExit(resolve(path))
    const Screen = (props: Launch) =>
      Exit.match(resolved, {
        onSuccess: ({ leaf, session: current }) => render(current, leaf, props),
        onFailure: (cause) => <ErrorScreen title="effect-cli-raycast could not start this command" cause={cause} />
      })
    Screen.displayName = `Command(${path})`
    return Screen
  }

  const runFromInput = (path: string, input: Readonly<Record<string, unknown>>) =>
    Effect.gen(function* () {
      const { leaf, session: current } = yield* resolve(path)
      const values = yield* Inputs.fromTool(leaf, input)
      const outcome = yield* execute(current, leaf, values, Triggers.Api)
      return outcome.context.result
    })

  return {
    session,
    leaf: (path) => Effect.map(resolve(path), ({ leaf }) => leaf),
    view: (path) =>
      screen(path, (current, leaf, props) => (
        <CommandForm session={current} leaf={leaf} seed={seedOf(current, leaf, props)} />
      )),
    customView: (path, render) =>
      screen(path, (current, leaf, props) => (
        <CustomForm session={current} leaf={leaf} seed={seedOf(current, leaf, props)} render={render} />
      )),
    noView: (path) => (props: Launch) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const { leaf, session: current } = yield* resolve(path)
          const explicit = Inputs.fromLaunchArguments(current, leaf, launchContextOf(props).arguments)
          const values = yield* Inputs.fromTokens(leaf, explicit)
          yield* execute(current, leaf, values, Triggers.NoView)
        }).pipe(
          Effect.catchTags({
            InvalidInput: failureToast,
            UnknownCommand: failureToast,
            ConfigError: failureToast,
            IntrospectError: failureToast,
            RaycastError: (error) => Effect.logError("NoView.raycastFailed", error),
            Cancelled: () => Effect.void
          })
        )
      ),
    browser: () => Browser,
    run: runFromInput,
    tool: (path, input) =>
      runtime.runPromise(
        runFromInput(path, input).pipe(
          Effect.filterOrFail(
            (result) => Runner.isSuccess(result.exitCode),
            (result) => new CommandFailed({ result })
          ),
          Effect.map((result) => result.stdout)
        )
      ),
    confirmation: (path) => (input) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const { leaf, session: current } = yield* resolve(path)
          const commandLine = yield* Inputs.fromTool(leaf, input).pipe(
            Effect.map((values: Field.FieldValues) => Argv.commandLine(leaf, Argv.build(leaf, values))),
            Effect.orElseSucceed(() => leaf.command.path.join(" "))
          )
          return Option.map(Config.confirmation(current.config, leaf.command), (message) => ({
            style: Action.Style.Destructive,
            message,
            info: [{ name: "Command", value: commandLine }]
          }))
        }).pipe(Effect.map(Option.getOrUndefined))
      )
  }
}
