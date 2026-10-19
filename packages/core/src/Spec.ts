/**
 * The serializable intermediate representation of a CLI.
 *
 * Everything downstream (codegen, the Raycast runtime, AI tools, tests) reads
 * these schemas and never touches Effect CLI internals.
 */
import { Array as Arr, Match, Option, pipe, Schema, String as Str } from "effect"
import { RaycastMeta } from "./Annotations.ts"
import * as Include from "./Include.ts"

/* -------------------------------------------------------------------------- */
/* Identifiers                                                                */
/* -------------------------------------------------------------------------- */

/** Unique id inside a leaf form, e.g. `acme.deploy.force` or `acme.deploy.@files`. */
export const ParamId = Schema.String.pipe(Schema.brand("ParamId"))
export type ParamId = typeof ParamId.Type

/** Space-separated command path without the root name (`"db migrate"`, `""` = root). */
export const PathKey = Schema.String.pipe(Schema.brand("PathKey"))
export type PathKey = typeof PathKey.Type

/** Full path including the root name, e.g. `["acme", "deploy"]`. */
export const CommandPath = Schema.NonEmptyArray(Schema.String)
export type CommandPath = typeof CommandPath.Type

/**
 * The argv-level values of one param, before flag syntax is applied. Every
 * input surface (form widgets, launch arguments, AI tools, history, defaults)
 * converges on this representation.
 */
export const Tokens = Schema.Array(Schema.String)
export type Tokens = typeof Tokens.Type

/* -------------------------------------------------------------------------- */
/* Params                                                                     */
/* -------------------------------------------------------------------------- */

export const PathType = Schema.Literals(["file", "directory", "either"])
export type PathType = typeof PathType.Type

/** The primitive behind a param; type-specific data lives on its case only. */
export const ParamType = Schema.TaggedUnion({
  Boolean: {},
  String: {},
  Int: {},
  Number: {},
  Date: {},
  Choice: { choices: Schema.Array(Schema.String) },
  Path: { pathType: PathType },
  Secret: {},
  FileText: {},
  FileParse: {},
  KeyValue: {},
  Unknown: { primitive: Schema.String }
})
export type ParamType = typeof ParamType.Type

export const Multiplicity = Schema.TaggedUnion({
  Single: {},
  Variadic: { min: Schema.Int, max: Schema.OptionFromOptionalKey(Schema.Int) }
})
export type Multiplicity = typeof Multiplicity.Type

/** Whether the parser accepts the param being absent, and what it then yields. */
export const Presence = Schema.TaggedUnion({
  Required: {},
  Optional: { default: Schema.OptionFromOptionalKey(Tokens) }
})
export type Presence = typeof Presence.Type

export const ParamKind = Schema.Literals(["flag", "argument"])
export type ParamKind = typeof ParamKind.Type

/** Where the value comes from at run time. */
export const Placement = Schema.Literals(["form", "preference", "hidden"])
export type Placement = typeof Placement.Type

export const ParamSpec = Schema.Struct({
  id: ParamId,
  kind: ParamKind,
  name: Schema.String,
  title: Schema.String,
  aliases: Schema.Array(Schema.String),
  description: Schema.OptionFromOptionalKey(Schema.String),
  type: ParamType,
  multiplicity: Multiplicity,
  presence: Presence,
  placement: Placement,
  /** Path of the command that owns the param (shared flags are owned by a parent). */
  ownerPath: CommandPath
})
export interface ParamSpec extends Schema.Schema.Type<typeof ParamSpec> {}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

export const ExampleSpec = Schema.Struct({
  command: Schema.String,
  description: Schema.OptionFromOptionalKey(Schema.String)
})
export interface ExampleSpec extends Schema.Schema.Type<typeof ExampleSpec> {}

const commandFields = {
  path: CommandPath,
  name: Schema.String,
  title: Schema.String,
  description: Schema.OptionFromOptionalKey(Schema.String),
  shortDescription: Schema.OptionFromOptionalKey(Schema.String),
  alias: Schema.OptionFromOptionalKey(Schema.String),
  group: Schema.OptionFromOptionalKey(Schema.String),
  examples: Schema.Array(ExampleSpec),
  /** Params parsed when this command itself runs (leaf). */
  params: Schema.Array(ParamSpec),
  /** Params declared with `withSharedFlags`, inherited by every descendant. */
  sharedParams: Schema.Array(ParamSpec),
  unlisted: Schema.Boolean,
  meta: RaycastMeta
}

export interface CommandSpec extends Schema.Struct.Type<typeof commandFields> {
  readonly children: ReadonlyArray<CommandSpec>
}

export interface CommandSpecEncoded extends Schema.Struct.Encoded<typeof commandFields> {
  readonly children: ReadonlyArray<CommandSpecEncoded>
}

export const CommandSpec = Schema.Struct({
  ...commandFields,
  children: Schema.Array(Schema.suspend((): Schema.Codec<CommandSpec, CommandSpecEncoded> => CommandSpec))
})

export const CliSpec = Schema.Struct({
  version: Schema.String,
  root: CommandSpec
})
export interface CliSpec extends Schema.Schema.Type<typeof CliSpec> {}

/** A runnable command with the full param list a form needs (ancestors' shared params first). */
export const LeafSpec = Schema.Struct({
  command: CommandSpec,
  /** Ancestor chain from the root to the command, inclusive. */
  lineage: Schema.NonEmptyArray(CommandSpec),
  fields: Schema.Array(ParamSpec)
})
export interface LeafSpec extends Schema.Schema.Type<typeof LeafSpec> {}

/* -------------------------------------------------------------------------- */
/* Param predicates                                                           */
/* -------------------------------------------------------------------------- */

export const isRequired = (param: ParamSpec): boolean => Presence.guards.Required(param.presence)

export const isVariadic = (param: ParamSpec): boolean => Multiplicity.guards.Variadic(param.multiplicity)

export const isBoolean = (param: ParamSpec): boolean => ParamType.guards.Boolean(param.type)

export const isSecret = (param: ParamSpec): boolean => ParamType.guards.Secret(param.type)

/** Several values per param: variadic params and repeated `key=value` pairs. */
export const isMultiValued = (param: ParamSpec): boolean => isVariadic(param) || ParamType.guards.KeyValue(param.type)

export const isFormField = (param: ParamSpec): boolean => param.placement === "form"

export const isPreference = (param: ParamSpec): boolean => param.placement === "preference"

export const defaultTokens = (param: ParamSpec): Option.Option<Tokens> =>
  Presence.match(param.presence, {
    Required: () => Option.none(),
    Optional: (presence) => presence.default
  })

/** The choices of a `Choice` param; every other type has none. */
export const choicesOf = (param: ParamSpec): ReadonlyArray<string> =>
  Match.value(param.type).pipe(
    Match.tag("Choice", (type) => type.choices),
    Match.orElse(() => Arr.empty())
  )

/* -------------------------------------------------------------------------- */
/* Tree                                                                       */
/* -------------------------------------------------------------------------- */

const isVisible = (command: CommandSpec): boolean => !command.unlisted && command.meta.exclude !== true

export const isLeaf = (command: CommandSpec): boolean =>
  command.meta.runnable ?? command.children.every((child) => child.unlisted)

/** Depth-first walk over visible commands. */
export const walk = (command: CommandSpec): Array<CommandSpec> =>
  Arr.filter([command], isVisible).flatMap((visible) => [visible, ...visible.children.flatMap(walk)])

const leafOf = (lineage: Lineage): LeafSpec => {
  const command = Arr.lastNonEmpty(lineage)
  return {
    command,
    lineage,
    fields: [...Arr.initNonEmpty(lineage).flatMap((ancestor) => ancestor.sharedParams), ...command.params].filter(
      (param) => param.placement !== "hidden"
    )
  }
}

const visibleLeaves = (lineage: Lineage): Array<LeafSpec> => {
  const command = Arr.lastNonEmpty(lineage)
  return Arr.filter([command], isVisible).flatMap((visible) => [
    ...Include.when(isLeaf(visible), () => leafOf(lineage)),
    ...visible.children.flatMap((child) => visibleLeaves(Arr.append(lineage, child)))
  ])
}

/** Every visible runnable command, depth-first. */
export const leaves = (spec: CliSpec): Array<LeafSpec> => visibleLeaves([spec.root])

const childNamed =
  (name: string) =>
  (command: CommandSpec): Option.Option<CommandSpec> =>
    Arr.findFirst(command.children, (child) => child.name === name || Option.contains(child.alias, name))

type Lineage = Arr.NonEmptyReadonlyArray<CommandSpec>

const descend = (lineage: Option.Option<Lineage>, name: string): Option.Option<Lineage> =>
  Option.flatMap(lineage, (found) =>
    Option.map(childNamed(name)(Arr.lastNonEmpty(found)), (child) => Arr.append(found, child))
  )

const lineageOf = (spec: CliSpec, path: ReadonlyArray<string>): Option.Option<Lineage> =>
  Arr.matchLeft(path, {
    onEmpty: () => Option.none(),
    onNonEmpty: (root, rest) =>
      Arr.reduce(
        rest,
        Option.liftPredicate<Lineage>([spec.root], () => root === spec.root.name),
        descend
      )
  })

export const findCommand = (spec: CliSpec, path: ReadonlyArray<string>): Option.Option<CommandSpec> =>
  Option.map(lineageOf(spec, path), Arr.lastNonEmpty)

/** The runnable command at `path`; groups without a handler are not leaves. */
export const findLeaf = (spec: CliSpec, path: ReadonlyArray<string>): Option.Option<LeafSpec> =>
  lineageOf(spec, path).pipe(
    Option.filter((lineage) => isLeaf(Arr.lastNonEmpty(lineage))),
    Option.map(leafOf)
  )

/* -------------------------------------------------------------------------- */
/* Names                                                                      */
/* -------------------------------------------------------------------------- */

/** `--name`: long flag syntax. */
export const FLAG_PREFIX = "--"
/** `-n`: single-letter alias syntax. */
export const SHORT_FLAG_PREFIX = "-"

const WORD_SEPARATOR = /[-_\s]+/
const NON_IDENTIFIER = /[^a-zA-Z0-9]+/
const PATH_KEY_SEPARATOR = " "
const COMMAND_NAME_SEPARATOR = "-"

/** `deploy-app` → `Deploy App`. */
export const humanize = (name: string): string =>
  pipe(
    name.split(WORD_SEPARATOR),
    Arr.filter(Str.isNonEmpty),
    Arr.match({ onEmpty: () => name, onNonEmpty: (words) => words.map(Str.capitalize).join(" ") })
  )

export const pathKey = (path: CommandPath): PathKey => PathKey.make(Arr.tailNonEmpty(path).join(PATH_KEY_SEPARATOR))

/** Path key → full path (`"db migrate"` → `["acme", "db", "migrate"]`). */
export const pathOf = (spec: CliSpec, key: string): CommandPath => [
  spec.root.name,
  ...key.split(PATH_KEY_SEPARATOR).filter(Str.isNonEmpty)
]

/** Stable Raycast command name for a path: `["acme","db","migrate"]` → `db-migrate`, root → `acme`. */
export const commandName = (path: CommandPath): string =>
  Arr.match(Arr.tailNonEmpty(path), {
    onEmpty: () => Arr.headNonEmpty(path),
    onNonEmpty: (rest) => rest.join(COMMAND_NAME_SEPARATOR)
  })

/** Raycast-safe identifier for arguments / preferences / tool inputs (`dry-run` → `dryRun`). */
export const identifier = (name: string): string =>
  pipe(
    name.split(NON_IDENTIFIER),
    Arr.filter(Str.isNonEmpty),
    Arr.match({ onEmpty: () => name, onNonEmpty: ([head, ...tail]) => [head, ...tail.map(Str.capitalize)].join("") })
  )

/** `Db Migrate`: the titles below the root, or the command's own title for the root itself. */
export const leafTitle = (leaf: LeafSpec): string =>
  Arr.match(Arr.tailNonEmpty(leaf.lineage), {
    onEmpty: () => leaf.command.title,
    onNonEmpty: (commands) => commands.map((command) => command.title).join(" ")
  })
