/**
 * Codecs between input surfaces and `Tokens`.
 *
 * A form widget, a Raycast preference, an AI tool argument and a stored
 * history value are different encodings of the same thing: the tokens a param
 * contributes to argv. Each widget is a `Schema` codec whose encoded side is
 * the widget's native value, so restoring a value is `encode` and submitting
 * it is `decode` (with the param's validation rules on the decoded side).
 */
import {
  Array as Arr,
  Match,
  Option,
  pipe,
  Record,
  Result,
  Schema,
  SchemaIssue,
  SchemaTransformation,
  String as Str
} from "effect"
import {
  defaultTokens,
  FLAG_PREFIX,
  isBoolean,
  isMultiValued,
  isRequired,
  isSecret,
  isVariadic,
  type LeafSpec,
  Multiplicity,
  ParamId,
  type ParamSpec,
  ParamType,
  type PathType,
  SHORT_FLAG_PREFIX,
  type Tokens,
  Tokens as TokensSchema
} from "./Spec.ts"

export const Widget = Schema.Literals(["text", "textarea", "password", "checkbox", "dropdown", "date", "file", "tags"])
export type Widget = typeof Widget.Type

const LINE_SEPARATOR = "\n"

/** The native value each widget reads and writes. */
export interface WidgetValues {
  readonly text: string
  readonly textarea: string
  readonly password: string
  readonly dropdown: string
  readonly checkbox: boolean
  readonly date: Date | null
  readonly file: ReadonlyArray<string>
  readonly tags: ReadonlyArray<string>
}

/** Tokens for every field of a leaf. */
export const FieldValues = Schema.Record(ParamId, TokensSchema)
export type FieldValues = typeof FieldValues.Type

/** One message per invalid field. */
export const FieldErrors = Schema.Record(ParamId, Schema.String)
export type FieldErrors = typeof FieldErrors.Type

/* -------------------------------------------------------------------------- */
/* Widget choice                                                              */
/* -------------------------------------------------------------------------- */

const byMultiplicity = (param: ParamSpec, single: Widget, variadic: Widget): Widget =>
  Multiplicity.match(param.multiplicity, { Single: () => single, Variadic: () => variadic })

/** The widget a param gets when the config does not force one. */
export const defaultWidget = (param: ParamSpec): Widget =>
  Match.value(param.type).pipe(
    Match.withReturnType<Widget>(),
    Match.tagsExhaustive({
      Boolean: () => "checkbox",
      Choice: () => byMultiplicity(param, "dropdown", "tags"),
      Date: () => "date",
      Path: () => "file",
      FileText: () => "file",
      FileParse: () => "file",
      Secret: () => "password",
      KeyValue: () => "textarea",
      String: () => byMultiplicity(param, "text", "textarea"),
      Int: () => byMultiplicity(param, "text", "textarea"),
      Number: () => byMultiplicity(param, "text", "textarea"),
      Unknown: () => byMultiplicity(param, "text", "textarea")
    })
  )

/* -------------------------------------------------------------------------- */
/* Hints                                                                      */
/* -------------------------------------------------------------------------- */

/** The hint shown in an empty text field. */
export const placeholder = (param: ParamSpec): Option.Option<string> =>
  Match.value(param).pipe(
    Match.when(
      (p) => ParamType.guards.KeyValue(p.type),
      () => Option.some("key=value, one per line")
    ),
    Match.when(isVariadic, () => Option.some("One value per line")),
    Match.when(
      (p) => ParamType.guards.Int(p.type),
      () => Option.some("Integer")
    ),
    Match.when(
      (p) => ParamType.guards.Number(p.type),
      () => Option.some("Number")
    ),
    Match.orElse((p) => Option.map(defaultTokens(p), (tokens) => tokens.join(", ")))
  )

const aliasSyntax = (alias: string): string =>
  Match.value(alias.length).pipe(
    Match.when(1, () => `${SHORT_FLAG_PREFIX}${alias}`),
    Match.orElse(() => `${FLAG_PREFIX}${alias}`)
  )

const usage = (param: ParamSpec): string =>
  Match.value(param.kind).pipe(
    Match.when("flag", () => [`${FLAG_PREFIX}${param.name}`, ...param.aliases.map(aliasSyntax)].join(", ")),
    Match.when("argument", () =>
      Multiplicity.match(param.multiplicity, { Single: () => `<${param.name}>`, Variadic: () => `<${param.name}...>` })
    ),
    Match.exhaustive
  )

/** Booleans show their state in the checkbox itself. */
const defaultLine = (param: ParamSpec): Option.Option<string> =>
  defaultTokens(param).pipe(
    Option.filter(() => !isBoolean(param)),
    Option.map((tokens) => `Default: ${tokens.join(", ")}`)
  )

/** Field help: the param's description, its CLI syntax and its default. */
export const describe = (param: ParamSpec): string =>
  Arr.getSomes([param.description, Option.some(usage(param)), defaultLine(param)]).join(LINE_SEPARATOR)

/** The path kind a file picker should offer. */
export const pathTypeOf = (param: ParamSpec): PathType =>
  Match.value(param.type).pipe(
    Match.tag("Path", ({ pathType }) => pathType),
    Match.orElse(() => "file" as const)
  )

/* -------------------------------------------------------------------------- */
/* Validation (decoded side)                                                  */
/* -------------------------------------------------------------------------- */

const INTEGER = /^-?\d+$/
const LINE_BREAK = /\r?\n/
const KEY_VALUE_SEPARATOR = "="

/** One message per field is enough; later rules would only repeat the first. */
const STOP_AT_FIRST_FAILURE = true

const parseDate = Schema.decodeUnknownOption(Schema.DateFromString)

const rule = (message: (tokens: Tokens) => Option.Option<string>) =>
  Schema.makeFilter<Tokens>((tokens) => Option.getOrElse(message(tokens), () => true), undefined, STOP_AT_FIRST_FAILURE)

const presenceRule = (param: ParamSpec) =>
  rule((tokens) =>
    Option.some("Required").pipe(
      Option.filter(() => isRequired(param) && !isBoolean(param) && Arr.isReadonlyArrayEmpty(tokens))
    )
  )

const countRule = (param: ParamSpec) =>
  rule((tokens) =>
    Multiplicity.match(param.multiplicity, {
      Single: () =>
        Option.some("Only one value is allowed").pipe(Option.filter(() => !isMultiValued(param) && tokens.length > 1)),
      Variadic: ({ min, max }) =>
        Option.firstSomeOf([
          Option.some(`At least ${min} value(s) required`).pipe(
            Option.filter(() => Arr.isReadonlyArrayNonEmpty(tokens) && tokens.length < min)
          ),
          Option.flatMap(max, (limit) =>
            Option.some(`At most ${limit} value(s) allowed`).pipe(Option.filter(() => tokens.length > limit))
          )
        ])
    })
  )

const tokenRule = (param: ParamSpec): Option.Option<(token: string) => Option.Option<string>> =>
  Match.value(param.type).pipe(
    Match.tag(
      "Int",
      () => (token: string) => Option.some("Must be an integer").pipe(Option.filter(() => !INTEGER.test(token)))
    ),
    Match.tag(
      "Number",
      () => (token: string) =>
        Option.some("Must be a number").pipe(Option.filter(() => !Number.isFinite(Number(token))))
    ),
    Match.tag(
      "Choice",
      ({ choices }) =>
        (token: string) =>
          Option.some(`Must be one of: ${choices.join(", ")}`).pipe(Option.filter(() => !choices.includes(token)))
    ),
    Match.tag(
      "Date",
      () => (token: string) => Option.some("Must be a date").pipe(Option.filter(() => Option.isNone(parseDate(token))))
    ),
    Match.tag(
      "KeyValue",
      () => (token: string) =>
        Option.some("Use key=value (one per line)").pipe(Option.filter(() => !token.includes(KEY_VALUE_SEPARATOR)))
    ),
    Match.option
  )

const eachTokenRule = (param: ParamSpec) =>
  rule((tokens) => Option.flatMap(tokenRule(param), (check) => Option.firstSomeOf(tokens.map(check))))

/** `Tokens` restricted to what the parser accepts for this param. */
export const tokensFor = (param: ParamSpec) =>
  TokensSchema.check(presenceRule(param), countRule(param), eachTokenRule(param))

/* -------------------------------------------------------------------------- */
/* Widget codecs                                                              */
/* -------------------------------------------------------------------------- */

const lines = (text: string): Tokens => text.split(LINE_BREAK).map(Str.trim).filter(Str.isNonEmpty)

const nonEmpty = (text: string): Tokens => Arr.filter([text], Str.isNonEmpty)

/** Free text: one line per value for multi-valued params; secrets keep their whitespace. */
const textTokens =
  (param: ParamSpec) =>
  (text: string): Tokens =>
    Match.value(param).pipe(
      Match.when(isMultiValued, () => lines(text)),
      Match.when(isSecret, () => nonEmpty(text)),
      Match.orElse(() => nonEmpty(text.trim()))
    )

interface WidgetCodec<A> {
  readonly encoded: Schema.Codec<A>
  readonly decode: (param: ParamSpec) => (value: A) => Tokens
  readonly encode: (tokens: Tokens) => A
}

const freeText: WidgetCodec<string> = {
  encoded: Schema.String,
  decode: textTokens,
  encode: (tokens) => tokens.join(LINE_SEPARATOR)
}

const checkbox: WidgetCodec<boolean> = {
  encoded: Schema.Boolean,
  decode: () => (checked) => [String(checked)],
  encode: (tokens) => Arr.contains(tokens, String(true))
}

const date: WidgetCodec<Date | null> = {
  encoded: Schema.NullOr(Schema.Date),
  decode: () => (value) =>
    Option.fromNullishOr(value).pipe(
      Option.map((d) => d.toISOString()),
      Option.toArray
    ),
  encode: (tokens) => Arr.head(tokens).pipe(Option.flatMap(parseDate), Option.getOrNull)
}

const list: WidgetCodec<ReadonlyArray<string>> = {
  encoded: Schema.Array(Schema.String),
  decode: () => Arr.filter(Str.isNonEmpty),
  encode: (tokens) => tokens
}

const widgets: { readonly [W in Widget]: WidgetCodec<WidgetValues[W]> } = {
  text: freeText,
  textarea: freeText,
  password: freeText,
  dropdown: freeText,
  checkbox,
  date,
  file: list,
  tags: list
}

/** Widget value ⇄ validated tokens. */
export const widgetCodec = <W extends Widget>(param: ParamSpec, widget: W): Schema.Codec<Tokens, WidgetValues[W]> => {
  const codec: WidgetCodec<WidgetValues[W]> = widgets[widget]
  return codec.encoded.pipe(
    Schema.decodeTo(
      tokensFor(param),
      SchemaTransformation.transform({ decode: codec.decode(param), encode: codec.encode })
    )
  )
}

/** The widget value that shows `tokens`; total, so restoring never fails. */
export const toWidget = <W extends Widget>(widget: W, tokens: Tokens): WidgetValues[W] => widgets[widget].encode(tokens)

/* -------------------------------------------------------------------------- */
/* Loose input (AI tools, preferences)                                        */
/* -------------------------------------------------------------------------- */

const stringFrom = <A>(schema: Schema.Codec<A>, encode: (text: string) => A) =>
  schema.pipe(Schema.decodeTo(Schema.String, SchemaTransformation.transform({ decode: String, encode })))

/** A scalar as the parser would read it back. */
export const Scalar = Schema.Union([
  Schema.String,
  stringFrom(Schema.Finite, Number),
  stringFrom(Schema.Boolean, (text) => text === String(true)),
  Schema.Date.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({ decode: (value) => value.toISOString(), encode: (iso) => new Date(iso) })
    )
  )
])

/** A scalar or a list of scalars, as JSON-ish input provides them. */
export const LooseTokens = Schema.Union([
  // A single scalar is exactly one token; encoding a longer list falls through to the array member.
  Scalar.pipe(
    Schema.decodeTo(
      Schema.Tuple([Schema.String]),
      SchemaTransformation.transform({ decode: (text): readonly [string] => [text], encode: ([text]) => text })
    )
  ),
  Schema.Array(Scalar)
])

export const looseCodec = (param: ParamSpec) => LooseTokens.pipe(Schema.decodeTo(tokensFor(param)))

/* -------------------------------------------------------------------------- */
/* Decoding a whole leaf                                                      */
/* -------------------------------------------------------------------------- */

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1()

const firstMessage = (error: Schema.SchemaError): string =>
  Arr.head(formatIssue(error.issue).issues).pipe(
    Option.match({ onNone: () => error.message, onSome: (issue) => issue.message })
  )

/** Decode one raw value; the error is the message shown next to the field. */
export const decode = (codec: Schema.Decoder<Tokens>, raw: unknown): Result.Result<Tokens, string> =>
  Schema.decodeUnknownResult(codec)(raw).pipe(Result.mapError(firstMessage))

/** Validate tokens that did not come through a codec (defaults, launch arguments). */
export const validate = (param: ParamSpec, tokens: Tokens): Result.Result<Tokens, string> =>
  decode(tokensFor(param), tokens)

/** Decode every field of a leaf; all failures are reported at once. */
export const decodeLeaf = (
  leaf: LeafSpec,
  decodeField: (param: ParamSpec) => Result.Result<Tokens, string>
): Result.Result<FieldValues, FieldErrors> => {
  const [values, errors] = Arr.separate(
    leaf.fields.map((param) =>
      decodeField(param).pipe(
        Result.mapBoth({
          onFailure: (error) => [param.id, error] as const,
          onSuccess: (tokens) => [param.id, tokens] as const
        })
      )
    )
  )
  return Arr.match(errors, {
    onEmpty: () => Result.succeed(Record.fromEntries(values)),
    onNonEmpty: (failures) => Result.fail(Record.fromEntries(failures))
  })
}

/** What a field shows before the user edits it: explicit values, then defaults. */
export const initialTokens = (param: ParamSpec, sources: ReadonlyArray<Option.Option<Tokens>>): Tokens =>
  pipe(Option.firstSomeOf([...sources, defaultTokens(param)]), Option.getOrElse(Arr.empty<string>))
