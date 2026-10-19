/**
 * `ecr` — the generator CLI run inside a Raycast extension:
 *
 * - `ecr sync`    write package.json commands/preferences/tools and `src/` stubs
 * - `ecr eject`   turn one generated stub into an editable form
 * - `ecr inspect` print what the generator reflects from the CLI
 */
import { type Config, Include, Manifest, Spec } from "@effect-cli-raycast/core"
import { Array as Arr, Boolean as Bool, Console, Effect, FileSystem, Match, Option, Path, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { eject, ensureEjectable } from "./Eject.ts"
import { loadConfig } from "./Load.ts"
import * as Plan from "./Plan.ts"

export class UnknownCommand extends Schema.TaggedError<UnknownCommand>()("UnknownCommand", {
  path: Schema.String
}) {
  override get message() {
    return `Unknown command: ${this.path}`
  }
}

export class HandWritten extends Schema.TaggedError<HandWritten>()("HandWritten", {
  file: Schema.String
}) {
  override get message() {
    return `${this.file} is already hand-written (use --force)`
  }
}

/** Every subcommand works on one extension: where it lives and which config module describes it. */
const extensionFlags = {
  config: Flag.String("config").pipe(
    Flag.withAlias("c"),
    Flag.withDescription("Config module exporting defineConfig(...) by default"),
    Flag.withDefault("raycast.config.ts")
  ),
  cwd: Flag.Directory("cwd").pipe(Flag.withDescription("Raycast extension root"), Flag.withDefault("."))
}

const PACKAGE_JSON = "package.json"
const LINE_END = "\n"

/** Plain JSON in and out, so `package.json` keeps its key order (see `Plan.asPackageJson`). */
const JsonFile = Schema.fromJsonString(Schema.Unknown, { space: 2 })
const SpecJson = Schema.fromJsonString(Spec.CliSpec, { space: 2 })

const openExtension = Effect.fnUntraced(function* (options: { readonly config: string; readonly cwd: string }) {
  const path = yield* Path.Path
  const root = path.resolve(options.cwd)
  const config = yield* loadConfig(path.resolve(root, options.config))
  return { root, config }
})

/** A file's contents, if it exists. */
const readIfExists = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(file).pipe(Effect.when(fs.exists(file)))
})

const isFile = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  return (yield* fs.stat(file)).type === "File"
})

/** Source files under `src/`, keyed by their `/`-separated path relative to the extension root. */
const readSources = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(root, Manifest.SOURCE_DIR)
  const entries = Option.getOrElse(
    yield* fs.readDirectory(dir, { recursive: true }).pipe(Effect.when(fs.exists(dir))),
    Arr.empty<string>
  )
  const candidates = entries.filter((entry) => Manifest.SOURCE_EXTENSIONS.includes(path.extname(entry)))
  const sources = yield* Effect.filter(candidates, (entry) => isFile(path.join(dir, entry)))
  return Plan.filesFrom(
    yield* Effect.forEach(sources, (entry) =>
      Effect.map(
        fs.readFileString(path.join(dir, entry)),
        (contents) => [[Manifest.SOURCE_DIR, ...entry.split(path.sep)].join("/"), contents] as const
      )
    )
  )
})

const readPackageJson = Effect.fnUntraced(function* (file: string) {
  const contents = yield* readIfExists(file)
  const packageJson = yield* Option.match(contents, {
    onNone: () => Effect.succeed<Plan.PackageJson>({}),
    onSome: (json) => Schema.decodeEffect(JsonFile)(json).pipe(Effect.flatMap(Plan.asPackageJson))
  })
  return { packageJson, contents }
})

const writeFile = Effect.fnUntraced(function* (root: string, file: Manifest.GeneratedFile) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const target = path.join(root, file.path)
  yield* fs.makeDirectory(path.dirname(target), { recursive: true })
  yield* fs.writeFileString(target, file.contents)
})

const sync = Command.make(
  "sync",
  {
    ...extensionFlags,
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print the plan without writing"),
      Flag.withDefault(false)
    )
  },
  (options) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { root, config } = yield* openExtension(options)
      const packageJsonPath = path.join(root, PACKAGE_JSON)
      const current = yield* readPackageJson(packageJsonPath)
      const plan = yield* Plan.plan({ config, packageJson: current.packageJson, files: yield* readSources(root) })
      const nextPackageJson = `${yield* Schema.encodeEffect(JsonFile)(plan.packageJson)}${LINE_END}`
      // Rewriting an unchanged file would only reformat it and churn its mtime.
      const packageJsonChanged = !Option.contains(current.contents, nextPackageJson)

      yield* Effect.forEach(plan.writes, (file) => Console.log(`write   ${file.path}`))
      yield* Effect.forEach(plan.deletes, (file) => Console.log(`delete  ${file}`))
      yield* Effect.forEach(plan.kept, (file) => Console.log(`keep    ${file} (ejected)`))
      yield* Console.log(
        Bool.match(packageJsonChanged, {
          onTrue: () => `update  ${PACKAGE_JSON} (${plan.packageJson.commands?.length ?? 0} commands)`,
          onFalse: () => `same    ${PACKAGE_JSON}`
        })
      )

      yield* Effect.gen(function* () {
        yield* Effect.forEach(plan.writes, (file) => writeFile(root, file))
        yield* Effect.forEach(plan.deletes, (file) => fs.remove(path.join(root, file)))
        yield* fs
          .writeFileString(packageJsonPath, nextPackageJson)
          .pipe(Effect.when(Effect.succeed(packageJsonChanged)))
      }).pipe(Effect.when(Effect.succeed(!options.dryRun)))
    })
).pipe(Command.withDescription("Generate Raycast commands, preferences and stubs from the CLI"))

const ejectCommand = Command.make(
  "eject",
  {
    ...extensionFlags,
    force: Flag.Boolean("force").pipe(
      Flag.withDescription("Overwrite an existing hand-written file"),
      Flag.withDefault(false)
    ),
    path: Argument.String("command").pipe(
      Argument.withDescription('Command path without the root, e.g. "db migrate"'),
      Argument.variadic({ min: 1 })
    )
  },
  (options) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const { root, config } = yield* openExtension(options)
      const leaf = yield* Effect.fromOption(Spec.findLeaf(config.spec, [config.spec.root.name, ...options.path])).pipe(
        Effect.mapError(() => new UnknownCommand({ path: options.path.join(" ") }))
      )
      yield* ensureEjectable(config, leaf)
      const target = `${Manifest.SOURCE_DIR}/${Spec.commandName(leaf.command.path)}.tsx`
      const files = yield* readSources(root)
      // A hand-written entry under any extension counts, not only the `.tsx` we would write.
      yield* Bool.match(!options.force && Plan.isUserOwned(files, Plan.entryBase(target)), {
        onTrue: () => Effect.fail(new HandWritten({ file: target })),
        onFalse: () => Effect.void
      })
      yield* writeFile(root, { path: target, contents: eject(config, leaf) })
      yield* Console.log(`ejected ${Spec.pathKey(leaf.command.path)} → ${path.relative(root, path.join(root, target))}`)
    })
).pipe(Command.withDescription("Write an editable form for a command; sync will leave it alone"))

const usage = (field: Spec.ParamSpec): string =>
  Match.value(field.kind).pipe(
    Match.when("flag", () => `${Spec.FLAG_PREFIX}${field.name}`),
    Match.when("argument", () => `<${field.name}>`),
    Match.exhaustive
  )

const traits = (field: Spec.ParamSpec): string =>
  [
    Bool.match(Spec.isRequired(field), { onTrue: () => "required", onFalse: () => "optional" }),
    ...Include.when(Spec.isVariadic(field), () => "variadic"),
    ...Include.when(Spec.isPreference(field), () => "preference"),
    ...Option.toArray(Option.map(Spec.defaultTokens(field), (tokens) => `default=${tokens.join(",")}`))
  ].join(", ")

const describeLeaf = (config: Config.RaycastConfig, leaf: Spec.LeafSpec): Array<string> => {
  const args = Manifest.quickArguments(config, leaf).map((field) => field.name)
  return [
    [
      `${leaf.command.path.join(" ")}  → ${Manifest.SOURCE_DIR}/${Spec.commandName(leaf.command.path)}.tsx`,
      ...Arr.match(args, { onEmpty: () => [], onNonEmpty: (names) => [`[args: ${names.join(", ")}]`] })
    ].join("  "),
    ...leaf.fields.map((field) => `    ${usage(field)}  ${field.type._tag}  (${traits(field)})`)
  ]
}

const inspect = Command.make(
  "inspect",
  {
    ...extensionFlags,
    json: Flag.Boolean("json").pipe(Flag.withDescription("Print the full spec as JSON"), Flag.withDefault(false))
  },
  (options) =>
    Effect.gen(function* () {
      const { config } = yield* openExtension(options)
      const manifest = Manifest.manifest(config)
      const summary = Effect.gen(function* () {
        yield* Effect.forEach(
          Spec.leaves(config.spec).flatMap((leaf) => describeLeaf(config, leaf)),
          (line) => Console.log(line)
        )
        yield* Console.log(
          `${LINE_END}${manifest.commands.length} Raycast commands, ${manifest.preferences.length} preferences, ${manifest.tools.length} AI tools`
        )
      })
      yield* Bool.match(options.json, {
        onTrue: () => Effect.flatMap(Schema.encodeEffect(SpecJson)(config.spec), Console.log),
        onFalse: () => summary
      })
    })
).pipe(Command.withDescription("Show what the generator sees"))

export const cli = Command.make("ecr").pipe(
  Command.withDescription("effect-cli-raycast — build a Raycast extension from an Effect CLI"),
  Command.withSubcommands([sync, ejectCommand, inspect])
)
