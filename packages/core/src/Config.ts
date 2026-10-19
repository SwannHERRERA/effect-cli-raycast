/**
 * `defineConfig(cli, options)` — the single value shared by the generator
 * (`ecr sync`) and the Raycast runtime (`makeRaycast`). Pure data + a runner;
 * React-level customisation lives in `effect-cli-raycast`'s `makeRaycast`.
 */
import { Array as Arr, Boolean as Bool, Effect, Match, Option, Predicate, Record, Schema } from "effect"
import { Command } from "effect/cli"
import { RaycastMeta } from "./Annotations.ts"
import { defaultWidget, Widget } from "./Field.ts"
import * as Include from "./Include.ts"
import * as Introspect from "./Introspect.ts"
import { isRunner } from "./Runner.ts"
import * as Spec from "./Spec.ts"
import { CliSpec, type CommandPath, type CommandSpec, type ParamSpec, pathKey, type Placement } from "./Spec.ts"

export const CommandStrategy = Schema.Literals(["leaves", "browser", "both"])
export type CommandStrategy = typeof CommandStrategy.Type

export const Persistence = Schema.Literals(["storeValue", "localStorage", "none"])
export type Persistence = typeof Persistence.Type

export const FeedbackMode = Schema.Literals(["toast", "hud", "silent"])
export type FeedbackMode = typeof FeedbackMode.Type

export const OutputView = Schema.Literals(["detail", "clipboard", "paste", "none"])
export type OutputView = typeof OutputView.Type

export const OutputFormat = Schema.Literals(["code", "markdown", "json"])
export type OutputFormat = typeof OutputFormat.Type

export const FieldOverride = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  info: Schema.optionalKey(Schema.String),
  /** Force a widget instead of the type-based default. */
  widget: Schema.optionalKey(Widget),
  hidden: Schema.optionalKey(Schema.Boolean)
})
export interface FieldOverride extends Schema.Schema.Type<typeof FieldOverride> {}

const RunnerSchema = Schema.declare(isRunner, { identifier: "Runner" })

const DEFAULT_HISTORY_MAX = 50
/** Module exporting `app = makeRaycast(...)`, relative to `src/`. */
export const DEFAULT_APP_MODULE = "./app"

const withDefault =
  <S extends Schema.Top>(value: S["Encoded"]) =>
  (schema: S) =>
    schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)))

/** Space-separated path patterns without the root name, e.g. `"db migrate"`. Prefix match. */
const Patterns = Schema.Array(Schema.String).pipe(withDefault([]))

export const Options = Schema.Struct({
  version: Schema.String,
  runner: RunnerSchema,
  commands: Schema.Struct({
    strategy: CommandStrategy.pipe(withDefault("both")),
    include: Patterns,
    exclude: Patterns,
    /** Promote up to 3 required simple params to Raycast launch arguments. */
    quickArguments: Schema.Boolean.pipe(withDefault(true)),
    /** Raycast command name for the tree browser. */
    browserName: Schema.String.pipe(withDefault("browse"))
  }).pipe(withDefault({})),
  form: Schema.Struct({
    persistence: Persistence.pipe(withDefault("storeValue")),
    drafts: Schema.Boolean.pipe(withDefault(true)),
    /** Keyed by `ParamSpec.id` (`acme.deploy.env`) or by bare param name (`env`). */
    fields: Schema.Record(Schema.String, FieldOverride).pipe(withDefault({}))
  }).pipe(withDefault({})),
  feedback: Schema.Struct({
    mode: FeedbackMode.pipe(withDefault("toast")),
    /** Paths that require `confirmAlert` before running. */
    confirm: Patterns
  }).pipe(withDefault({})),
  output: Schema.Struct({
    view: OutputView.pipe(withDefault("detail")),
    format: OutputFormat.pipe(withDefault("code"))
  }).pipe(withDefault({})),
  history: Schema.Struct({
    enabled: Schema.Boolean.pipe(withDefault(true)),
    max: Schema.Int.check(Schema.isGreaterThan(0)).pipe(withDefault(DEFAULT_HISTORY_MAX))
  }).pipe(withDefault({})),
  /** Flag names exposed as Raycast extension preferences instead of form fields. */
  preferences: Schema.Array(Schema.String).pipe(withDefault([])),
  ai: Schema.Struct({ tools: Schema.Boolean.pipe(withDefault(false)) }).pipe(withDefault({})),
  codegen: Schema.Struct({
    /** Module exporting `app = makeRaycast(...)`, as imported from `src/`. */
    appModule: Schema.String.pipe(withDefault(DEFAULT_APP_MODULE))
  }).pipe(withDefault({})),
  /** Keyed by space-separated path without the root (`""` = root). */
  overrides: Schema.Record(Schema.String, RaycastMeta).pipe(withDefault({}))
})
export interface Options extends Schema.Schema.Type<typeof Options> {}
/** What `defineConfig` accepts: every group and key besides `version` / `runner` is optional. */
export type OptionsInput = typeof Options.Encoded

export const RaycastConfig = Schema.Struct({
  command: Schema.declare((u): u is Command.Command.Any => Command.isCommand(u), { identifier: "Command" }),
  spec: CliSpec,
  options: Options
})
export interface RaycastConfig extends Schema.Schema.Type<typeof RaycastConfig> {}

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  reason: Schema.String
}) {
  override get message() {
    return this.reason
  }
}

/* -------------------------------------------------------------------------- */
/* Path patterns                                                              */
/* -------------------------------------------------------------------------- */

/** `"db"` covers `db` and everything below it. */
const covers =
  (key: string) =>
  (pattern: string): boolean =>
    key === pattern || key.startsWith(`${pattern} `)

/** `"db migrate"` needs `db` to stay in the tree so the pattern can be reached. */
const leadsTo =
  (key: string) =>
  (pattern: string): boolean =>
    pattern.startsWith(`${key} `)

const matchesAny = (path: CommandPath, patterns: ReadonlyArray<string>): boolean => patterns.some(covers(pathKey(path)))

const isIncluded =
  (include: ReadonlyArray<string>) =>
  (command: CommandSpec): boolean =>
    include.length === 0 || matchesAny(command.path, include) || include.some(leadsTo(pathKey(command.path)))

const isExcluded =
  (exclude: ReadonlyArray<string>) =>
  (command: CommandSpec): boolean =>
    matchesAny(command.path, exclude)

/* -------------------------------------------------------------------------- */
/* Spec adjustments                                                           */
/* -------------------------------------------------------------------------- */

/** An override keyed by param id wins over one keyed by bare name. */
export const fieldOverride = (options: Options, param: ParamSpec): Option.Option<FieldOverride> =>
  Option.orElse(Record.get(options.form.fields, param.id), () => Record.get(options.form.fields, param.name))

/** The widget a field is rendered with: the config can force one per field. */
export const widgetOf = (options: Options, param: ParamSpec): Widget =>
  fieldOverride(options, param).pipe(
    Option.flatMapNullishOr((override) => override.widget),
    Option.getOrElse(() => defaultWidget(param))
  )

const isHidden =
  (options: Options) =>
  (param: ParamSpec): boolean =>
    param.placement === "hidden" || Option.exists(fieldOverride(options, param), (field) => field.hidden === true)

const isConfiguredPreference =
  (options: Options) =>
  (param: ParamSpec): boolean =>
    param.kind === "flag" && options.preferences.includes(param.name)

const placementOf = (options: Options, param: ParamSpec): Placement =>
  Match.value(param).pipe(
    Match.withReturnType<Placement>(),
    Match.when(isHidden(options), () => "hidden"),
    Match.when(isConfiguredPreference(options), () => "preference"),
    Match.orElse(() => "form")
  )

const adjustParam =
  (options: Options) =>
  (param: ParamSpec): ParamSpec => ({
    ...param,
    title: fieldOverride(options, param).pipe(
      Option.flatMapNullishOr((field) => field.title),
      Option.getOrElse(() => param.title)
    ),
    placement: placementOf(options, param)
  })

/**
 * Filtered-out commands are marked excluded rather than removed: a group whose
 * children are all filtered must not turn into a runnable leaf.
 */
const markExcluded =
  (options: Options) =>
  (child: CommandSpec): CommandSpec =>
    Bool.match(isIncluded(options.commands.include)(child) && !isExcluded(options.commands.exclude)(child), {
      onTrue: () => child,
      onFalse: () => ({ ...child, meta: { ...child.meta, exclude: true } })
    })

const adjustCommand =
  (options: Options) =>
  (command: CommandSpec): CommandSpec => {
    const override = Record.get(options.overrides, pathKey(command.path))
    return {
      ...command,
      meta: Option.match(override, { onNone: () => command.meta, onSome: (meta) => ({ ...command.meta, ...meta }) }),
      title: override.pipe(
        Option.flatMapNullishOr((meta) => meta.title),
        Option.getOrElse(() => command.title)
      ),
      description: override.pipe(
        Option.flatMapNullishOr((meta) => meta.description),
        Option.orElse(() => command.description)
      ),
      params: command.params.map(adjustParam(options)),
      sharedParams: command.sharedParams.map(adjustParam(options)),
      children: command.children.map(markExcluded(options)).map(adjustCommand(options))
    }
  }

/* -------------------------------------------------------------------------- */
/* Generated names                                                            */
/* -------------------------------------------------------------------------- */

export const showsLeaves = (options: Options): boolean => options.commands.strategy !== "browser"

/** The browser only makes sense for a CLI with subcommands. */
export const showsBrowser = (options: Options, spec: CliSpec): boolean =>
  options.commands.strategy !== "leaves" && Arr.isReadonlyArrayNonEmpty(spec.root.children)

const duplicates = (names: ReadonlyArray<string>): Array<string> =>
  Arr.dedupe(names.filter((name, index) => names.indexOf(name) !== index))

/**
 * Raycast keys commands, launch arguments, tool inputs and preferences by
 * name, so two params or commands that map to the same name would silently
 * shadow each other. Reported up front instead.
 */
const conflicts = (options: Options, spec: CliSpec): Array<string> => {
  const leaves = Spec.leaves(spec)
  const commandNames = [
    ...Include.when(showsBrowser(options, spec), () => options.commands.browserName),
    ...Include.when(showsLeaves(options), () => leaves.map((leaf) => Spec.commandName(leaf.command.path))).flat()
  ]
  const fieldClashes = leaves.flatMap((leaf) =>
    duplicates(leaf.fields.filter(Spec.isFormField).map((param) => Spec.identifier(param.name))).map(
      (name) => `${leaf.command.path.join(" ")}: several params map to the input name "${name}"`
    )
  )
  const preferences = Arr.dedupeWith(
    leaves.flatMap((leaf) => leaf.fields.filter(Spec.isPreference)),
    (a, b) => a.id === b.id
  )
  return [
    ...duplicates(commandNames).map((name) => `several Raycast commands are named "${name}"`),
    ...fieldClashes,
    ...preferences
      .filter(Spec.isMultiValued)
      .map((param) => `--${param.name} takes several values and cannot be a Raycast preference`),
    ...duplicates(
      Arr.dedupeWith(preferences, (a, b) => a.name === b.name && a.type._tag === b.type._tag).map((param) =>
        Spec.identifier(param.name)
      )
    ).map((name) => `preference "${name}" is declared by flags of different types`)
  ]
}

const resolve = Effect.fn("Config.resolve")(function* (command: Command.Command.Any, input: OptionsInput) {
  const options = yield* Schema.decodeUnknownEffect(Options)(input).pipe(
    Effect.mapError((error) => new ConfigError({ reason: error.message }))
  )
  const reflected = yield* Introspect.fromCommand(command, { version: options.version })
  const spec: CliSpec = { ...reflected, root: adjustCommand(options)(reflected.root) }
  yield* Arr.match(conflicts(options, spec), {
    onEmpty: () => Effect.void,
    onNonEmpty: (problems) => Effect.fail(new ConfigError({ reason: problems.join("\n") }))
  })
  return { command, spec, options } satisfies RaycastConfig
})

const DefinitionTypeId = "~effect-cli-raycast/Config/Definition"

/**
 * What `raycast.config.ts` exports: a description of the config. Reflecting the
 * CLI can fail, so it only happens when the generator or the runtime resolves it.
 */
export interface Definition {
  readonly [DefinitionTypeId]: typeof DefinitionTypeId
  readonly resolve: Effect.Effect<RaycastConfig, ConfigError | Introspect.IntrospectError>
}

export const isDefinition = (u: unknown): u is Definition => Predicate.hasProperty(u, DefinitionTypeId)

export const defineConfig = (command: Command.Command.Any, input: OptionsInput): Definition => ({
  [DefinitionTypeId]: DefinitionTypeId,
  resolve: resolve(command, input)
})

/**
 * The prompt to show before running, if any. The command's own `confirm`
 * annotation wins over the config's `feedback.confirm` patterns.
 */
export const confirmation = (config: RaycastConfig, command: CommandSpec): Option.Option<string> => {
  const prompt = `Run ${command.title}?`
  return Match.value(command.meta.confirm).pipe(
    Match.when(Match.string, (message) => Option.some(message)),
    Match.when(true, () => Option.some(prompt)),
    Match.when(false, () => Option.none()),
    Match.orElse(() =>
      Option.some(prompt).pipe(Option.filter(() => matchesAny(command.path, config.options.feedback.confirm)))
    )
  )
}
