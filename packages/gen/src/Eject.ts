/**
 * `ecr eject <path>` — expand a leaf into an explicit, editable Raycast form.
 * The output has no generated marker, so `ecr sync` never touches it again,
 * but it renders through `app.customView`, so behaviour (validation, argv
 * building, feedback, history) stays identical to the generated form.
 */
import { Config, Field, Include, Source, Spec } from "@effect-cli-raycast/core"
import { Effect, Match, Option, Schema } from "effect"
import * as Jsx from "./Jsx.ts"

/** The `defaultValue` attribute for a param's default, in the widget's own value type. */
const defaultValue = (widget: Field.Widget, tokens: Spec.Tokens): Option.Option<Jsx.Attribute> =>
  Match.value(widget).pipe(
    Match.when("checkbox", (w) =>
      Option.some(Jsx.expression("defaultValue", Source.boolean(Field.toWidget(w, tokens))))
    ),
    Match.when("date", (w) =>
      Option.map(Option.fromNullishOr(Field.toWidget(w, tokens)), (date) =>
        Jsx.expression("defaultValue", `new Date(${Source.string(date.toISOString())})`)
      )
    ),
    Match.whenOr("file", "tags", () => Option.some(Jsx.expression("defaultValue", Source.stringArray(tokens)))),
    // Secrets never get a default (see Introspect), and a password field must not show one.
    Match.when("password", () => Option.none()),
    Match.whenOr("text", "textarea", "dropdown", (w) =>
      Option.some(Jsx.text("defaultValue", Field.toWidget(w, tokens)))
    ),
    Match.exhaustive
  )

const items = (tag: string, choices: ReadonlyArray<string>): Array<Jsx.Element> =>
  choices.map((choice) => Jsx.element(tag, [Jsx.text("value", choice), Jsx.text("title", choice)]))

/** Optional dropdowns need an explicit "nothing selected" entry. */
const noChoice = (param: Spec.ParamSpec): Array<Jsx.Element> =>
  Include.when(!Spec.isRequired(param), () =>
    Jsx.element("Form.Dropdown.Item", [Jsx.text("value", ""), Jsx.text("title", "—")])
  )

const fieldElement = (config: Config.RaycastConfig, param: Spec.ParamSpec): Jsx.Element => {
  const widget = Config.widgetOf(config.options, param)
  const stores = config.options.form.persistence === "storeValue" && !Spec.isSecret(param)
  const common = [
    Jsx.text("id", param.id),
    Jsx.text("title", param.title),
    Jsx.text("info", Field.describe(param)),
    Jsx.expression("error", `form.errorOf(${Source.string(param.id)})`),
    ...Include.when(stores, () => Jsx.flag("storeValue")),
    ...Option.toArray(Option.flatMap(Spec.defaultTokens(param), (tokens) => defaultValue(widget, tokens)))
  ]
  const placeholder = Option.toArray(Option.map(Field.placeholder(param), (hint) => Jsx.text("placeholder", hint)))
  return Match.value(widget).pipe(
    Match.when("checkbox", () =>
      Jsx.element("Form.Checkbox", [
        ...common,
        Jsx.text(
          "label",
          Option.getOrElse(param.description, () => param.title)
        )
      ])
    ),
    Match.when("dropdown", () =>
      Jsx.element("Form.Dropdown", common, [...noChoice(param), ...items("Form.Dropdown.Item", Spec.choicesOf(param))])
    ),
    Match.when("tags", () =>
      Jsx.element("Form.TagPicker", common, items("Form.TagPicker.Item", Spec.choicesOf(param)))
    ),
    Match.when("date", () => Jsx.element("Form.DatePicker", common)),
    Match.when("file", () =>
      Jsx.element("Form.FilePicker", [
        ...common,
        Jsx.expression("allowMultipleSelection", Source.boolean(Spec.isVariadic(param))),
        Jsx.expression("canChooseDirectories", Source.boolean(Field.pathTypeOf(param) !== "file")),
        Jsx.expression("canChooseFiles", Source.boolean(Field.pathTypeOf(param) !== "directory"))
      ])
    ),
    Match.when("password", () => Jsx.element("Form.PasswordField", common)),
    Match.when("textarea", () => Jsx.element("Form.TextArea", [...common, ...placeholder])),
    Match.when("text", () => Jsx.element("Form.TextField", [...common, ...placeholder])),
    Match.exhaustive
  )
}

const formElement = (config: Config.RaycastConfig, leaf: Spec.LeafSpec): Jsx.Element =>
  Jsx.element(
    "Form",
    [
      Jsx.text("navigationTitle", leaf.command.path.join(" ")),
      Jsx.expression("isLoading", "form.isLoading"),
      Jsx.nested(
        "actions",
        Jsx.element(
          "ActionPanel",
          [],
          [
            Jsx.element("Action.SubmitForm", [
              Jsx.text("title", `Run ${leaf.command.title}`),
              Jsx.expression("icon", "Icon.Play"),
              Jsx.expression("onSubmit", "form.submit")
            ])
          ]
        )
      )
    ],
    [
      ...Option.toArray(
        Option.map(leaf.command.description, (text) => Jsx.element("Form.Description", [Jsx.text("text", text)]))
      ),
      ...leaf.fields.filter(Spec.isFormField).map((param) => fieldElement(config, param))
    ]
  )

export class NotEjectable extends Schema.TaggedError<NotEjectable>()("NotEjectable", {
  path: Schema.String,
  reason: Schema.String
}) {
  override get message() {
    return `Cannot eject "${this.path}": ${this.reason}`
  }
}

/**
 * Only view commands that have their own Raycast entry can become a form:
 * a `no-view` command has no screen, and with the `browser` strategy no entry
 * would ever point at the file.
 */
export const ensureEjectable = (
  config: Config.RaycastConfig,
  leaf: Spec.LeafSpec
): Effect.Effect<void, NotEjectable> => {
  const fail = (reason: string) => Effect.fail(new NotEjectable({ path: Spec.pathKey(leaf.command.path), reason }))
  return Match.value({ mode: leaf.command.meta.mode, strategy: config.options.commands.strategy }).pipe(
    Match.when({ mode: "no-view" }, () => fail("it is a no-view command")),
    Match.when({ strategy: "browser" }, () =>
      fail('commands.strategy is "browser", so it has no Raycast entry of its own')
    ),
    Match.orElse(() => Effect.void)
  )
}

export const eject = (config: Config.RaycastConfig, leaf: Spec.LeafSpec): string =>
  Source.lines(
    `import { Action, ActionPanel, Form, Icon } from "@raycast/api"`,
    `import { app } from ${Source.string(config.options.codegen.appModule)}`,
    "",
    `// Ejected from \`${leaf.command.path.join(" ")}\`. This file is yours: \`ecr sync\` will not overwrite it.`,
    `export default app.customView(${Source.string(Spec.pathKey(leaf.command.path))}, (form) => (`,
    Jsx.print(formElement(config, leaf)).map((line) => `  ${line}`),
    "))",
    ""
  )
