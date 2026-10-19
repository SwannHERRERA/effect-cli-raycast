/**
 * Every input surface → field tokens: form submissions, launch arguments,
 * AI tool input and extension preferences all decode through `Field` codecs.
 */
import { Config, Field, Manifest, Spec } from "@effect-cli-raycast/core"
import { Boolean as Bool, Effect, Option, Record, Result } from "effect"
import { Raycast } from "./Raycast.ts"
import { InvalidInput, type LaunchMode, type Session } from "./types.ts"

/** The widget a field is rendered with: the config can force one per field. */
export const widgetOf = (session: Session, param: Spec.ParamSpec): Field.Widget =>
  Config.widgetOf(session.config.options, param)

/** Preference values are named after the camelCased flag. */
const preferenceTokens = (param: Spec.ParamSpec): Effect.Effect<Result.Result<Spec.Tokens, string>, never, Raycast> =>
  Effect.map(
    Raycast.use((raycast) => raycast.preference(Manifest.identifier(param.name))),
    (value) =>
      Option.match(Option.flatMap(value, Option.fromNullishOr), {
        onNone: () => Field.validate(param, Field.initialTokens(param, [])),
        onSome: (raw) => Field.decode(Field.looseCodec(param), raw)
      })
  )

const decodeWith = (
  leaf: Spec.LeafSpec,
  fromForm: (param: Spec.ParamSpec) => Result.Result<Spec.Tokens, string>
): Effect.Effect<Field.FieldValues, InvalidInput, Raycast> =>
  Effect.gen(function* () {
    const preferences = Record.fromEntries(
      yield* Effect.forEach(leaf.fields.filter(Spec.isPreference), (param) =>
        Effect.map(preferenceTokens(param), (tokens) => [param.id, tokens] as const)
      )
    )
    const decoded = Field.decodeLeaf(leaf, (param) =>
      Record.get(preferences, param.id).pipe(Option.getOrElse(() => fromForm(param)))
    )
    return yield* Result.match(decoded, {
      onFailure: (errors) => Effect.fail(new InvalidInput({ errors })),
      onSuccess: Effect.succeed
    })
  })

/** A Raycast form submission (`Form.Values`, keyed by field id). */
export const fromForm = (session: Session, leaf: Spec.LeafSpec, raw: Readonly<Record<string, unknown>>) =>
  decodeWith(leaf, (param) => {
    const widget = widgetOf(session, param)
    const value = Record.get(raw, param.id).pipe(
      Option.flatMap(Option.fromUndefinedOr),
      Option.getOrElse(() => Field.toWidget(widget, []))
    )
    return Field.decode(Field.widgetCodec(param, widget), value)
  })

/** Validated tokens (history re-runs, launch arguments + defaults). */
export const fromTokens = (leaf: Spec.LeafSpec, values: Field.FieldValues) =>
  decodeWith(leaf, (param) => Field.validate(param, Field.initialTokens(param, [Record.get(values, param.id)])))

/** AI tool input, keyed by camelCased param name (bare names are accepted too). */
export const fromTool = (leaf: Spec.LeafSpec, input: Readonly<Record<string, unknown>>) =>
  decodeWith(leaf, (param) =>
    Record.get(input, Manifest.identifier(param.name)).pipe(
      Option.orElse(() => Record.get(input, param.name)),
      Option.flatMap(Option.fromNullishOr),
      Option.match({
        onNone: () => Field.validate(param, Field.initialTokens(param, [])),
        onSome: (raw) => Field.decode(Field.looseCodec(param), raw)
      })
    )
  )

/** Raycast launch arguments mapped back to field ids (see `Manifest.quickArguments`). */
export const fromLaunchArguments = (
  session: Session,
  leaf: Spec.LeafSpec,
  args: Readonly<Record<string, string | undefined>>
): Field.FieldValues =>
  Record.fromEntries(
    Manifest.quickArguments(session.config, leaf).flatMap((param) =>
      Record.get(args, Manifest.identifier(param.name)).pipe(
        Option.flatMap(Option.fromUndefinedOr),
        Option.flatMap((raw) => Result.getSuccess(Field.decode(Field.widgetCodec(param, "text"), raw))),
        Option.map((tokens) => [param.id, tokens] as const),
        Option.toArray
      )
    )
  )

/** A field the user must fill before the command can run. */
const needsInput = (param: Spec.ParamSpec): boolean =>
  Spec.isFormField(param) && Spec.isRequired(param) && !Spec.isBoolean(param)

/** Launch arguments that cover every required field run the command straight away. */
export const launchOf = (leaf: Spec.LeafSpec, explicit: Field.FieldValues): LaunchMode =>
  Bool.match(
    !Record.isEmptyRecord(explicit) && leaf.fields.filter(needsInput).every((param) => Record.has(explicit, param.id)),
    {
      onTrue: () => "run",
      onFalse: () => "edit"
    }
  )
