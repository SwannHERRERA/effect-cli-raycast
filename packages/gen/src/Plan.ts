/**
 * Pure sync planning: (config, current package.json, current files) → changes.
 *
 * Ownership rule: an entry point is ours while every file for it starts with
 * `GENERATED_MARKER`. Ejected or hand-written files (no marker, any extension)
 * are never overwritten or deleted, and their manifest entries are preserved.
 *
 * Known limitation: generated and hand-added preferences cannot be told apart
 * once written, so a preference whose flag was removed from the CLI stays in
 * package.json until it is deleted by hand.
 */
import { type Config, Manifest } from "@effect-cli-raycast/core"
import { Array as Arr, Boolean as Bool, Effect, HashMap, HashSet, Option, pipe, Record, Schema } from "effect"

/** A manifest entry: only `name` matters for merging, other keys pass through untouched. */
export const Entry = Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown)
])
export type Entry = typeof Entry.Type

export const PackageJson = Schema.StructWithRest(
  Schema.Struct({
    commands: Schema.optionalKey(Schema.Array(Entry)),
    tools: Schema.optionalKey(Schema.Array(Entry)),
    preferences: Schema.optionalKey(Schema.Array(Entry))
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)
export type PackageJson = typeof PackageJson.Type

export class InvalidPackageJson extends Schema.TaggedError<InvalidPackageJson>()("InvalidPackageJson", {
  reason: Schema.String
}) {}

/**
 * Validates without rebuilding the object: decoding a struct-with-rest moves
 * the known keys first, and package.json should keep the author's key order.
 */
export const asPackageJson = (value: unknown): Effect.Effect<PackageJson, InvalidPackageJson> =>
  Effect.succeed(value).pipe(
    Effect.filterOrFail(
      Schema.is(PackageJson),
      () =>
        new InvalidPackageJson({
          reason: "expected an object whose commands / tools / preferences entries have a name"
        })
    )
  )

/** Source files keyed by path relative to the extension root (`src/deploy.tsx`). */
export type Files = HashMap.HashMap<string, string>

export const filesFrom = (entries: Iterable<readonly [path: string, contents: string]>): Files =>
  HashMap.fromIterable(entries)

export interface SyncInput {
  readonly config: Config.RaycastConfig
  readonly packageJson: PackageJson
  readonly files: Files
}

export interface SyncPlan {
  readonly packageJson: PackageJson
  readonly writes: ReadonlyArray<Manifest.GeneratedFile>
  readonly deletes: ReadonlyArray<string>
  /** Files kept because they were ejected / hand-written. */
  readonly kept: ReadonlyArray<string>
}

/* -------------------------------------------------------------------------- */
/* Ownership                                                                  */
/* -------------------------------------------------------------------------- */

const extensionOf = (path: string): Option.Option<string> =>
  Arr.findFirst(Manifest.SOURCE_EXTENSIONS, (extension) => path.endsWith(extension))

/** `src/deploy.tsx` → `src/deploy`: Raycast resolves an entry point by name, whatever its extension. */
export const entryBase = (path: string): string =>
  Option.match(extensionOf(path), { onNone: () => path, onSome: (extension) => path.slice(0, -extension.length) })

/** An entry point belongs to the user as soon as any of its files lacks the marker. */
export const isUserOwned = (files: Files, base: string): boolean =>
  Manifest.SOURCE_EXTENSIONS.some((extension) =>
    Option.exists(HashMap.get(files, `${base}${extension}`), (contents) => !Manifest.isGenerated(contents))
  )

/* -------------------------------------------------------------------------- */
/* package.json                                                               */
/* -------------------------------------------------------------------------- */

/** Only for a brand-new extension: an existing package.json is the author's, defaults would leak into it. */
const defaults = (config: Config.RaycastConfig): PackageJson => ({
  $schema: "https://www.raycast.com/schemas/extension.json",
  name: `${config.spec.root.name}-raycast`,
  title: config.spec.root.title,
  description: Option.getOrElse(config.spec.root.description, () => `Run ${config.spec.root.name} from Raycast`),
  icon: "icon.png",
  author: "unknown",
  license: "MIT",
  platforms: ["macOS"],
  categories: ["Developer Tools"],
  scripts: { build: "ray build", dev: "ray develop", lint: "ray lint", sync: "ecr sync" }
})

/** Keep entries whose source file is hand-written; replace everything we generate. */
const mergeEntries =
  (files: Files, dir: string) =>
  (current: ReadonlyArray<Entry>, next: ReadonlyArray<Entry>): Array<Entry> => {
    const userOwned = current.filter((entry) => isUserOwned(files, `${dir}/${entry.name}`))
    const owned = HashMap.fromIterable(userOwned.map((entry) => [entry.name, entry] as const))
    const nextNames = HashSet.fromIterable(next.map((entry) => entry.name))
    return [
      ...next.map((entry) => Option.getOrElse(HashMap.get(owned, entry.name), () => entry)),
      ...userOwned.filter((entry) => !HashSet.has(nextNames, entry.name))
    ]
  }

/** Generated preferences win on name clash; extra user preferences are kept. */
const mergePreferences = (current: ReadonlyArray<Entry>, next: ReadonlyArray<Entry>): Array<Entry> => {
  const names = HashSet.fromIterable(next.map((entry) => entry.name))
  return [...next, ...current.filter((entry) => !HashSet.has(names, entry.name))]
}

/** Optional sections are present only when non-empty; Raycast requires `commands` itself. */
const section = (entries: ReadonlyArray<Entry>): Option.Option<ReadonlyArray<Entry>> =>
  Option.liftPredicate(entries, Arr.isReadonlyArrayNonEmpty)

const Sections = Schema.Struct({
  commands: Schema.Array(Entry),
  preferences: Schema.OptionFromOptionalKey(Schema.Array(Entry)),
  tools: Schema.OptionFromOptionalKey(Schema.Array(Entry))
})

const SECTION_KEYS = HashSet.fromIterable(Object.keys(Sections.fields))

const entriesOf = (entries: ReadonlyArray<Entry> | undefined): ReadonlyArray<Entry> =>
  Option.getOrElse(Option.fromUndefinedOr(entries), Arr.empty<Entry>)

/* -------------------------------------------------------------------------- */
/* Plan                                                                       */
/* -------------------------------------------------------------------------- */

export const plan = Effect.fn("Plan.plan")(function* (input: SyncInput) {
  const { config, packageJson, files } = input
  const manifest = yield* Schema.encodeEffect(Manifest.Manifest)(Manifest.manifest(config))
  const generated = Manifest.stubs(config)

  const isOurs = (file: Manifest.GeneratedFile): boolean => !isUserOwned(files, entryBase(file.path))
  const writes = generated.filter(
    (file) => isOurs(file) && !Option.contains(HashMap.get(files, file.path), file.contents)
  )
  const kept = generated.filter((file) => !isOurs(file)).map((file) => file.path)
  const wanted = HashSet.fromIterable(generated.map((file) => file.path))
  const deletes = pipe(
    files,
    HashMap.filter((contents, path) => !HashSet.has(wanted, path) && Manifest.isGenerated(contents)),
    HashMap.keys,
    Arr.fromIterable
  )

  const sections = yield* Schema.encodeEffect(Sections)({
    commands: mergeEntries(files, Manifest.SOURCE_DIR)(entriesOf(packageJson.commands), manifest.commands),
    preferences: section(mergePreferences(entriesOf(packageJson.preferences), manifest.preferences)),
    tools: section(mergeEntries(files, Manifest.TOOLS_DIR)(entriesOf(packageJson.tools), manifest.tools))
  })
  const base = Bool.match(Record.isEmptyRecord(packageJson), {
    onTrue: () => defaults(config),
    onFalse: () => packageJson
  })
  // Existing keys keep their slot when spread over; new sections are appended.
  const merged: Readonly<Record<string, unknown>> = { ...base, ...sections }
  const present = HashSet.fromIterable(Object.keys(sections))
  const isStale = (key: string) => HashSet.has(SECTION_KEYS, key) && !HashSet.has(present, key)
  return {
    packageJson: yield* asPackageJson(Record.filter(merged, (_, key) => !isStale(key))),
    writes,
    deletes,
    kept
  } satisfies SyncPlan
})
