/**
 * Turns an `effect/cli` command tree into a `CliSpec`.
 *
 * This is the ONLY module that reads Effect CLI internals: the per-command
 * `config` / `contextConfig` fields (the same data the built-in `--wizard`
 * walks) and the `choiceKeys` / `pathType` fields of primitives. Both are
 * decoded with schemas, so an incompatible `effect` release fails with an
 * `IntrospectError` instead of producing a wrong spec. Contract tests in
 * `test/Introspect.test.ts` pin this behaviour to the installed `effect`.
 */
import { Array as Arr, Boolean as Bool, Effect, Exit, Match, Option, Schema } from "effect"
import { type Command, Param } from "effect/cli"
import * as Annotations from "./Annotations.ts"
import { LooseTokens } from "./Field.ts"
import { reflectionLayer } from "./Headless.ts"
import {
  type CliSpec,
  type CommandPath,
  type CommandSpec,
  humanize,
  Multiplicity,
  ParamId,
  type ParamSpec,
  ParamType,
  PathType,
  Presence,
  type Tokens
} from "./Spec.ts"

export class IntrospectError extends Schema.TaggedError<IntrospectError>()("IntrospectError", {
  path: Schema.Array(Schema.String),
  reason: Schema.String
}) {
  override get message() {
    return `Cannot reflect command "${this.path.join(" ")}": ${this.reason}`
  }
}

/* -------------------------------------------------------------------------- */
/* Internal shapes                                                            */
/* -------------------------------------------------------------------------- */

const AnyParam = Schema.declare((u): u is Param.Any => Param.isParam(u))

const ConfigInternal = Schema.Struct({
  flags: Schema.Array(AnyParam),
  arguments: Schema.Array(AnyParam)
})
type ConfigInternal = typeof ConfigInternal.Type

const CommandInternal = Schema.Struct({
  config: ConfigInternal,
  contextConfig: ConfigInternal
})

const internals = (command: Command.Command.Any, path: CommandPath) =>
  Schema.decodeUnknownEffect(CommandInternal)(command).pipe(
    Effect.mapError(
      () => new IntrospectError({ path, reason: "unsupported effect/cli version (missing command config)" })
    )
  )

const PlainTag = Schema.Literals([
  "Boolean",
  "String",
  "Int",
  "Finite",
  "Date",
  "Redacted",
  "FileText",
  "FileParse",
  "FileSchema",
  "KeyValuePair"
])

/** Primitive tags whose reflected type carries no extra data. */
const plainTypes: { readonly [Tag in typeof PlainTag.Type]: ParamType } = {
  Boolean: ParamType.cases.Boolean.make({}),
  String: ParamType.cases.String.make({}),
  Int: ParamType.cases.Int.make({}),
  Finite: ParamType.cases.Number.make({}),
  Date: ParamType.cases.Date.make({}),
  Redacted: ParamType.cases.Secret.make({}),
  FileText: ParamType.cases.FileText.make({}),
  FileParse: ParamType.cases.FileParse.make({}),
  FileSchema: ParamType.cases.FileParse.make({}),
  KeyValuePair: ParamType.cases.KeyValue.make({})
}

const PrimitiveInternal = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Choice"), choiceKeys: Schema.Array(Schema.String) }),
  Schema.Struct({ _tag: Schema.Literal("Path"), pathType: PathType }),
  Schema.Struct({ _tag: PlainTag })
])

const typeOf = (primitive: Param.Single<Param.ParamKind, unknown>["primitiveType"]): ParamType =>
  Schema.decodeUnknownOption(PrimitiveInternal)(primitive).pipe(
    Option.map((decoded) =>
      Match.value(decoded).pipe(
        Match.when({ _tag: "Choice" }, ({ choiceKeys }) => ParamType.cases.Choice.make({ choices: choiceKeys })),
        Match.when({ _tag: "Path" }, ({ pathType }) => ParamType.cases.Path.make({ pathType })),
        Match.orElse(({ _tag }) => plainTypes[_tag])
      )
    ),
    Option.getOrElse(() => ParamType.cases.Unknown.make({ primitive: primitive._tag }))
  )

/* -------------------------------------------------------------------------- */
/* Param tree                                                                 */
/* -------------------------------------------------------------------------- */

type AnySingle = Param.Single<Param.ParamKind, unknown>

type ParamNode =
  | AnySingle
  | Param.Map<Param.ParamKind, unknown, unknown>
  | Param.Transform<Param.ParamKind, unknown, unknown>
  | Param.Optional<Param.ParamKind, unknown>
  | Param.Variadic<Param.ParamKind, unknown>

/** The leaf inputs behind a combinator tree, and whether it repeats. */
interface Shape {
  readonly singles: ReadonlyArray<AnySingle>
  readonly multiplicity: Multiplicity
  /**
   * The parsed value is no longer what the user typed (`Flag.map`, `mapEffect`, …),
   * so a probed default cannot be turned back into tokens.
   */
  readonly mapsValue: boolean
}

const single = Multiplicity.cases.Single.make({})

// `Param.Any` exposes `_tag` without narrowing to the node interfaces the
// module exports, so the union is restated here to make the match exhaustive.
const shapeOf = (param: Param.Any): Shape =>
  Match.value(param as ParamNode).pipe(
    Match.tagsExhaustive({
      Single: (node): Shape => ({ singles: [node], multiplicity: single, mapsValue: false }),
      Map: (node) => ({ ...shapeOf(node.param), mapsValue: mapsValue(node.param) }),
      Optional: (node) => shapeOf(node.param),
      Transform: (node) => {
        const inner = shapeOf(node.param)
        return {
          ...inner,
          singles: [...inner.singles, ...node.alternatives.flatMap((alternative) => shapeOf(alternative()).singles)],
          mapsValue: mapsValue(node.param)
        }
      },
      Variadic: (node) => ({
        ...shapeOf(node.param),
        multiplicity: Multiplicity.cases.Variadic.make({
          min: Option.getOrElse(node.min, () => 0),
          max: node.max
        })
      })
    })
  )

/**
 * `withDefault` is itself a map over `optional`, so that one map keeps the
 * user's value; any other map or transform changes it.
 */
const mapsValue = (inner: Param.Any): boolean =>
  Match.value(inner as ParamNode).pipe(
    Match.tag("Optional", (node) => shapeOf(node.param).mapsValue),
    Match.orElse(() => true)
  )

const defaultOf = (value: unknown): Option.Option<Tokens> =>
  Match.value(value).pipe(
    Match.when(Option.isOption, (option) => Option.flatMap(option, defaultOf)),
    Match.orElse(Schema.decodeUnknownOption(LooseTokens))
  )

/**
 * Secrets never yield a default: `Redacted` matches no `LooseTokens` member.
 *
 * `withDefault` keeps its value in a closure, so it is recovered by parsing an
 * empty input: success ⇒ the param may be omitted (and yields the default),
 * failure ⇒ the param is required.
 */
const presenceOf = (param: Param.Any, shape: Shape): Effect.Effect<Presence> =>
  param.parse({ flags: {}, arguments: [] }).pipe(
    Effect.provide(reflectionLayer),
    Effect.exit,
    Effect.map(
      Exit.match({
        onSuccess: ([, value]) =>
          Presence.cases.Optional.make({ default: Option.filter(defaultOf(value), () => !shape.mapsValue) }),
        onFailure: () => Presence.cases.Required.make({})
      })
    )
  )

const ARGUMENT_PREFIX = "@"
const ID_SEPARATOR = "."

/** Arguments and flags may share a name, so arguments get a prefix. */
const localId = (input: AnySingle): string =>
  Match.value(input.kind).pipe(
    Match.when("argument", () => `${ARGUMENT_PREFIX}${input.name}`),
    Match.orElse(() => input.name)
  )

const paramId = (ownerPath: CommandPath, input: AnySingle): ParamId =>
  ParamId.make([...ownerPath, localId(input)].join(ID_SEPARATOR))

const paramSpecs = (param: Param.Any, ownerPath: CommandPath): Effect.Effect<Array<ParamSpec>> => {
  const shape = shapeOf(param)
  // Combinators like `orElse` expose several singles; the first one is the
  // primary input, alternatives are not representable as a single field.
  return Option.match(Arr.head(shape.singles), {
    onNone: () => Effect.succeed([]),
    onSome: (input) =>
      Effect.map(presenceOf(param, shape), (presence): Array<ParamSpec> => [
        {
          id: paramId(ownerPath, input),
          kind: input.kind,
          name: input.name,
          title: humanize(input.name),
          aliases: input.aliases,
          description: input.description,
          type: typeOf(input.primitiveType),
          multiplicity: shape.multiplicity,
          presence,
          placement: Bool.match(input.hidden, { onTrue: () => "hidden", onFalse: () => "form" }),
          ownerPath
        }
      ])
  })
}

const configSpecs = (config: ConfigInternal, ownerPath: CommandPath): Effect.Effect<Array<ParamSpec>> =>
  Effect.forEach([...config.flags, ...config.arguments], (param) => paramSpecs(param, ownerPath)).pipe(
    Effect.map(Arr.flatten)
  )

/* -------------------------------------------------------------------------- */
/* Command tree                                                               */
/* -------------------------------------------------------------------------- */

const commandSpec = (
  command: Command.Command.Any,
  parentPath: ReadonlyArray<string>,
  group: Option.Option<string>
): Effect.Effect<CommandSpec, IntrospectError> =>
  Effect.gen(function* () {
    const path: CommandPath = Arr.append(parentPath, command.name)
    const { config, contextConfig } = yield* internals(command, path)
    const meta = Annotations.get(command.annotations)
    const children = yield* Effect.forEach(command.subcommands, (entry) =>
      Effect.forEach(entry.commands, (child) => commandSpec(child, path, Option.fromUndefinedOr(entry.group)))
    )
    return {
      path,
      name: command.name,
      title: meta.title ?? humanize(command.name),
      description: Option.fromUndefinedOr(meta.description ?? command.description),
      shortDescription: Option.fromUndefinedOr(command.shortDescription),
      alias: Option.fromUndefinedOr(command.alias),
      group,
      examples: command.examples.map((example) => ({
        command: example.command,
        description: Option.fromUndefinedOr(example.description)
      })),
      params: yield* configSpecs(config, path),
      sharedParams: yield* configSpecs(contextConfig, path),
      children: Arr.flatten(children),
      unlisted: command.unlisted,
      meta
    }
  })

/** Reflect a command tree; fails with `IntrospectError` on unsupported `effect` versions. */
export const fromCommand = Effect.fn("Introspect.fromCommand")(function* (
  command: Command.Command.Any,
  options: { readonly version: string }
) {
  const root: CommandSpec = yield* commandSpec(command, [], Option.none())
  return { version: options.version, root } satisfies CliSpec
})
