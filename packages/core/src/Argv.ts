/**
 * Field tokens → argv for `Command.runWith` (root name excluded).
 *
 * Mirrors the token layout of `effect/cli`'s built-in wizard: for each level of
 * the command path, the subcommand name followed by that level's shared flags,
 * then the leaf's own flags, then its positional arguments.
 */
import { Array as Arr, Boolean as Bool, Match, Option, Record, Redacted, Schema } from "effect"
import type { FieldValues } from "./Field.ts"
import {
  defaultTokens,
  FLAG_PREFIX,
  isBoolean,
  isSecret,
  isVariadic,
  type LeafSpec,
  type ParamSpec,
  type Tokens
} from "./Spec.ts"

/** A value as typed by the user; secrets stay redacted until the process is spawned. */
export const Value = Schema.TaggedUnion({
  Plain: { text: Schema.String },
  Secret: { text: Schema.Redacted(Schema.String) }
})
export type Value = typeof Value.Type

export const Arg = Schema.TaggedUnion({
  Subcommand: { name: Schema.String },
  /** `--force` */
  Switch: { name: Schema.String },
  /** `--env=prod` */
  Flag: { name: Schema.String, value: Value },
  /** `--`: stops flag parsing so positional values may start with a dash. */
  EndOfOptions: {},
  Positional: { value: Value }
})
export type Arg = typeof Arg.Type

export type Argv = ReadonlyArray<Arg>

const MASK = "••••"
const SHELL_SAFE = /^[A-Za-z0-9_./:@%+=,-]+$/
const SINGLE_QUOTE = "'"
const ESCAPED_SINGLE_QUOTE = `'"'"'`

/* -------------------------------------------------------------------------- */
/* Building                                                                   */
/* -------------------------------------------------------------------------- */

const valueOf =
  (param: ParamSpec) =>
  (text: string): Value =>
    Match.value(param).pipe(
      Match.when(isSecret, () => Value.cases.Secret.make({ text: Redacted.make(text) })),
      Match.orElse(() => Value.cases.Plain.make({ text }))
    )

/** A boolean equal to its default is left to the parser; one without a default must always be sent. */
const booleanArgs = (param: ParamSpec, tokens: Tokens): Array<Arg> => {
  const enabled = Arr.contains(tokens, String(true))
  const isDefault = Option.exists(defaultTokens(param), Arr.contains(String(enabled)))
  return Arr.filter([enabled], () => !isDefault).map((on) =>
    Bool.match(on, {
      onTrue: () => Arg.cases.Switch.make({ name: param.name }),
      onFalse: () => Arg.cases.Flag.make({ name: param.name, value: valueOf(param)(String(false)) })
    })
  )
}

const flagArgs = (param: ParamSpec, tokens: Tokens): Array<Arg> =>
  Match.value(param).pipe(
    Match.when(
      (p) => isBoolean(p) && !isVariadic(p),
      () => booleanArgs(param, tokens)
    ),
    Match.orElse(() => tokens.map((text) => Arg.cases.Flag.make({ name: param.name, value: valueOf(param)(text) })))
  )

const startsLikeFlag = (arg: Arg): boolean =>
  Arg.guards.Positional(arg) &&
  Value.match(arg.value, {
    Plain: ({ text }) => text.startsWith("-"),
    Secret: ({ text }) => Redacted.value(text).startsWith("-")
  })

/** Build argv from validated field tokens (see `Field.decodeLeaf`). */
export const build = (leaf: LeafSpec, values: FieldValues): Argv => {
  // Only the leaf's fields are sent: hidden params are left to the parser, and
  // the leaf's own shared flags belong to its (non-existent) children.
  const fields = new Set(leaf.fields.map((field) => field.id))
  const tokensOf = (param: ParamSpec): Tokens => Record.get(values, param.id).pipe(Option.getOrElse(Arr.empty<string>))
  const flags = (params: ReadonlyArray<ParamSpec>): Array<Arg> =>
    params
      .filter((param) => param.kind === "flag" && fields.has(param.id))
      .flatMap((param) => flagArgs(param, tokensOf(param)))
  const positionals = leaf.command.params
    .filter((param) => param.kind === "argument" && fields.has(param.id))
    .flatMap((param) => tokensOf(param).map((text) => Arg.cases.Positional.make({ value: valueOf(param)(text) })))
  const [root, ...descendants] = leaf.lineage
  return [
    ...flags(root.sharedParams),
    ...descendants.flatMap((command) => [
      Arg.cases.Subcommand.make({ name: command.name }),
      ...flags(command.sharedParams)
    ]),
    ...flags(leaf.command.params),
    ...Arr.filter([Arg.cases.EndOfOptions.make({})], () => positionals.some(startsLikeFlag)),
    ...positionals
  ]
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

const reveal = (value: Value): string =>
  Value.match(value, { Plain: ({ text }) => text, Secret: ({ text }) => Redacted.value(text) })

/** The arguments handed to the process. */
export const toArgs = (argv: Argv): Array<string> =>
  argv.map((arg) =>
    Arg.match(arg, {
      Subcommand: ({ name }) => name,
      Switch: ({ name }) => `${FLAG_PREFIX}${name}`,
      Flag: ({ name, value }) => `${FLAG_PREFIX}${name}=${reveal(value)}`,
      EndOfOptions: () => FLAG_PREFIX,
      Positional: ({ value }) => reveal(value)
    })
  )

const quote = (arg: string): string =>
  Match.value(arg).pipe(
    Match.when(
      (text) => SHELL_SAFE.test(text),
      (text) => text
    ),
    Match.orElse((text) => `${SINGLE_QUOTE}${text.replaceAll(SINGLE_QUOTE, ESCAPED_SINGLE_QUOTE)}${SINGLE_QUOTE}`)
  )

const display = (arg: Arg): string =>
  Arg.match(arg, {
    Subcommand: ({ name }) => quote(name),
    Switch: ({ name }) => quote(`${FLAG_PREFIX}${name}`),
    Flag: ({ name, value }) =>
      Value.match(value, {
        Plain: ({ text }) => quote(`${FLAG_PREFIX}${name}=${text}`),
        Secret: () => `${quote(`${FLAG_PREFIX}${name}`)}=${MASK}`
      }),
    EndOfOptions: () => FLAG_PREFIX,
    Positional: ({ value }) => Value.match(value, { Plain: ({ text }) => quote(text), Secret: () => MASK })
  })

/** Shell-style rendering for display / copy, secrets masked (`acme deploy --env=prod --token=•••• 'my file'`). */
export const format = (rootName: string, argv: Argv): string => [quote(rootName), ...argv.map(display)].join(" ")

/** `format` for a leaf's own root command. */
export const commandLine = (leaf: LeafSpec, argv: Argv): string => format(Arr.headNonEmpty(leaf.lineage).name, argv)
