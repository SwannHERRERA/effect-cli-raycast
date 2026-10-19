import { Argv, Config, Field, Spec } from "@effect-cli-raycast/core"
import { Action, ActionPanel, Form, Icon, Toast } from "@raycast/api"
import { Array as Arr, Effect, Match, Option, Order, Record, Result, Schema } from "effect"
import { Fragment, type ReactNode } from "react"
import { ErrorScreen } from "./ErrorScreen.tsx"
import { defaultWidgets } from "./fields.tsx"
import { History } from "./history.ts"
import { AsyncState, runAction, useEffectState } from "./hooks.ts"
import * as Inputs from "./inputs.ts"
import { Raycast } from "./Raycast.ts"
import { type FieldProps, type FieldRenderer, LaunchMode, type Session, Shortcuts } from "./types.ts"
import { errorOf, RunState, useRunner } from "./useRunner.tsx"

/** Where a form starts from. */
export const FormSeed = Schema.Struct({
  /** Values given explicitly (history re-run, launch arguments); they win over drafts and stored values. */
  explicit: Field.FieldValues,
  /** Raycast form drafts: widget values keyed by field id. */
  drafts: Schema.Record(Schema.String, Schema.Unknown),
  launch: LaunchMode
})
export interface FormSeed extends Schema.Schema.Type<typeof FormSeed> {}

export const emptySeed: FormSeed = { explicit: {}, drafts: {}, launch: "edit" }

export interface CommandFormProps {
  readonly session: Session
  readonly leaf: Spec.LeafSpec
  readonly seed: FormSeed
}

/* -------------------------------------------------------------------------- */
/* Field order                                                                */
/* -------------------------------------------------------------------------- */

/** Arguments first, then required flags, then optional ones. */
const rank = (field: Spec.ParamSpec): number =>
  Match.value(field).pipe(
    Match.when({ kind: "argument" }, () => 0),
    Match.when(Spec.isRequired, () => 1),
    Match.orElse(() => 2)
  )

const byRank = Order.mapInput(Order.Number, rank)

const isOwnedBy =
  (leaf: Spec.LeafSpec) =>
  (field: Spec.ParamSpec): boolean =>
    field.ownerPath.length === leaf.command.path.length

const sameOwner = (a: Spec.ParamSpec, b: Spec.ParamSpec): boolean => a.ownerPath.join(" ") === b.ownerPath.join(" ")

/** Own fields (ranked), then inherited shared flags grouped by the command that declares them. */
const sectionsOf = (leaf: Spec.LeafSpec) => {
  const fields = leaf.fields.filter(Spec.isFormField)
  return {
    own: fields.filter(isOwnedBy(leaf)).toSorted(byRank),
    inherited: Arr.match(
      fields.filter((field) => !isOwnedBy(leaf)(field)),
      {
        onEmpty: () => [],
        onNonEmpty: (inherited) => Arr.groupWith(inherited, sameOwner)
      }
    )
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering one field                                                        */
/* -------------------------------------------------------------------------- */

/** A renderer for this field, then for its widget kind, then the default one. */
const rendererFor = <W extends Field.Widget>(session: Session, param: Spec.ParamSpec, widget: W): FieldRenderer<W> => {
  const fields: Readonly<Record<string, FieldRenderer<W>>> = session.ui.fields ?? {}
  const widgets: Partial<{ readonly [K in Field.Widget]: FieldRenderer<K> }> = session.ui.widgets ?? {}
  const defaults: { readonly [K in Field.Widget]: FieldRenderer<K> } = defaultWidgets
  return Record.get(fields, param.id).pipe(
    Option.orElse(() => Record.get(fields, param.name)),
    Option.orElse(() => Option.fromUndefinedOr(widgets[widget])),
    Option.getOrElse(() => defaults[widget])
  )
}

const renderWidget = <W extends Field.Widget>(session: Session, props: FieldProps<W>): ReactNode =>
  rendererFor(session, props.param, props.widget)(props)

/* -------------------------------------------------------------------------- */
/* Form                                                                       */
/* -------------------------------------------------------------------------- */

export function CommandForm(props: CommandFormProps) {
  const { session, leaf, seed } = props
  const { options } = session.config
  const key = Spec.pathKey(leaf.command.path)
  const sections = sectionsOf(leaf)
  const runner = useRunner(session)

  const widgetOf = (param: Spec.ParamSpec) => Inputs.widgetOf(session, param)

  const draftOf = (param: Spec.ParamSpec): Option.Option<Spec.Tokens> =>
    Record.get(seed.drafts, param.id).pipe(
      Option.flatMap((raw) => Result.getSuccess(Field.decode(Field.widgetCodec(param, widgetOf(param)), raw)))
    )

  const initialOf =
    (restored: Option.Option<Field.FieldValues>) =>
    (param: Spec.ParamSpec): Spec.Tokens =>
      Field.initialTokens(param, [
        Record.get(seed.explicit, param.id),
        draftOf(param),
        Option.flatMap(restored, (values) => Record.get(values, param.id))
      ])

  const restoring = Match.value(options.form.persistence).pipe(
    Match.when("localStorage", () => History.use((history) => history.loadLastValues(key))),
    Match.orElse(() => Effect.succeed(Option.none<Field.FieldValues>()))
  )

  const [state] = useEffectState(session, key, () =>
    restoring.pipe(
      Effect.tap((restored) =>
        Match.value(seed.launch).pipe(
          Match.when("run", () => {
            const initial = initialOf(restored)
            return runner.submit(
              leaf,
              Inputs.fromTokens(leaf, Record.fromEntries(leaf.fields.map((param) => [param.id, initial(param)])))
            )
          }),
          Match.when("edit", () => Effect.void),
          Match.exhaustive
        )
      )
    )
  )

  const copyCommandLine = (values: Form.Values) =>
    Inputs.fromForm(session, leaf, values).pipe(
      Effect.map((decoded) => Argv.commandLine(leaf, Argv.build(leaf, decoded))),
      Effect.flatMap((line) =>
        Raycast.use((raycast) =>
          raycast
            .copy(line)
            .pipe(Effect.andThen(raycast.toast({ style: Toast.Style.Success, title: "Command line copied" })))
        )
      ),
      Effect.catchTag("InvalidInput", (invalid) => Effect.sync(() => runner.showErrors(invalid.errors)))
    )

  return AsyncState.$match(state, {
    Loading: () => <Form isLoading />,
    Failed: ({ cause }) => <ErrorScreen title={`Cannot open ${leaf.command.title}`} cause={cause} />,
    Ready: ({ value: restored }) => {
      const initial = initialOf(restored)

      const renderField = (param: Spec.ParamSpec, autoFocus: boolean): ReactNode => {
        const widget = widgetOf(param)
        const override = Config.fieldOverride(options, param).pipe(Option.getOrElse((): Config.FieldOverride => ({})))
        const validate = (value: unknown) => Field.decode(Field.widgetCodec(param, widget), value)
        const node = renderWidget(session, {
          param,
          override,
          widget,
          defaultValue: Field.toWidget(widget, initial(param)),
          item: {
            id: param.id,
            // The override title is already applied to the spec by `defineConfig`.
            title: param.title,
            info: Option.getOrElse(Option.fromUndefinedOr(override.info), () => Field.describe(param)),
            error: Option.getOrUndefined(errorOf(runner.state, param.id)),
            placeholder: Option.getOrUndefined(
              Option.orElse(Option.fromUndefinedOr(override.placeholder), () => Field.placeholder(param))
            ),
            storeValue:
              options.form.persistence === "storeValue" &&
              !Record.has(seed.explicit, param.id) &&
              !Spec.isSecret(param),
            autoFocus,
            onChange: () => runner.setFieldError(param.id, Option.none()),
            onBlur: (event) => runner.setFieldError(param.id, Result.getFailure(validate(event.target.value)))
          }
        })
        return <Fragment key={param.id}>{node}</Fragment>
      }

      const first = Arr.head([...sections.own, ...sections.inherited.flat()])
      const field = (param: Spec.ParamSpec) =>
        renderField(
          param,
          Option.exists(first, (head) => head.id === param.id)
        )

      return (
        <Form
          isLoading={RunState.$is("Running")(runner.state)}
          navigationTitle={leaf.command.path.join(" ")}
          enableDrafts={options.form.drafts}
          actions={
            <ActionPanel>
              <Action.SubmitForm
                title={`Run ${leaf.command.title}`}
                icon={Icon.Play}
                onSubmit={(values: Form.Values) =>
                  session.runtime.runPromise(runner.submit(leaf, Inputs.fromForm(session, leaf, values)))
                }
              />
              <Action.SubmitForm
                title="Copy Command Line"
                icon={Icon.Terminal}
                shortcut={Shortcuts.copyCommandLine}
                onSubmit={(values: Form.Values) => runAction(session, copyCommandLine(values))}
              />
              {Option.toArray(Option.fromUndefinedOr(session.ui.formActions)).map((actions) => (
                <Fragment key="extra">{actions(leaf)}</Fragment>
              ))}
            </ActionPanel>
          }
        >
          {Option.toArray(leaf.command.description).map((text) => (
            <Form.Description key="description" text={text} />
          ))}
          {sections.own.map(field)}
          {sections.inherited.map((group) => {
            const owner = Arr.headNonEmpty(group).ownerPath.join(" ")
            return [
              <Form.Separator key={`separator-${owner}`} />,
              <Form.Description key={`owner-${owner}`} title="Inherited" text={`Shared flags of ${owner}`} />,
              ...group.map(field)
            ]
          })}
        </Form>
      )
    }
  })
}
