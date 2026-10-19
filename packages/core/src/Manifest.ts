/**
 * Pure generation of the Raycast `package.json` fragments and `src/` stubs.
 * `ecr sync` writes these; nothing here touches the filesystem.
 */
import { Array as Arr, Boolean as Bool, Match, Option, pipe, Schema } from "effect"
import { Mode } from "./Annotations.ts"
import { confirmation, type RaycastConfig, showsBrowser, showsLeaves } from "./Config.ts"
import * as Include from "./Include.ts"
import * as Source from "./Source.ts"
import * as Spec from "./Spec.ts"
import {
  choicesOf,
  commandName,
  defaultTokens,
  isBoolean,
  isFormField,
  isMultiValued,
  isPreference,
  isRequired,
  isSecret,
  isVariadic,
  type LeafSpec,
  leaves,
  leafTitle,
  type ParamSpec,
  pathKey
} from "./Spec.ts"

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

const ChoiceOption = Schema.Struct({ title: Schema.String, value: Schema.String })

const argumentFields = {
  placeholder: Schema.String,
  required: Schema.Literal(true)
}

// Field order is the key order written to package.json.
export const ManifestArgument = Schema.Union([
  Schema.Struct({ name: Schema.String, type: Schema.Literal("text"), ...argumentFields }),
  Schema.Struct({ name: Schema.String, type: Schema.Literal("password"), ...argumentFields }),
  Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("dropdown"),
    ...argumentFields,
    data: Schema.Array(ChoiceOption)
  })
])
export type ManifestArgument = typeof ManifestArgument.Type

export const ManifestCommand = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  subtitle: Schema.OptionFromOptionalKey(Schema.String),
  description: Schema.String,
  mode: Mode,
  icon: Schema.OptionFromOptionalKey(Schema.String),
  keywords: Schema.OptionFromOptionalKey(Schema.Array(Schema.String)),
  arguments: Schema.OptionFromOptionalKey(Schema.NonEmptyArray(ManifestArgument))
})
export interface ManifestCommand extends Schema.Schema.Type<typeof ManifestCommand> {}

const preferenceFields = {
  name: Schema.String,
  title: Schema.String,
  description: Schema.String,
  required: Schema.Boolean
}
const TextDefault = Schema.OptionFromOptionalKey(Schema.String)

export const ManifestPreference = Schema.Union([
  Schema.Struct({ ...preferenceFields, type: Schema.Literal("textfield"), default: TextDefault }),
  Schema.Struct({ ...preferenceFields, type: Schema.Literal("password"), default: TextDefault }),
  Schema.Struct({ ...preferenceFields, type: Schema.Literal("file"), default: TextDefault }),
  Schema.Struct({ ...preferenceFields, type: Schema.Literal("directory"), default: TextDefault }),
  Schema.Struct({
    ...preferenceFields,
    type: Schema.Literal("dropdown"),
    default: TextDefault,
    data: Schema.Array(ChoiceOption)
  }),
  Schema.Struct({
    ...preferenceFields,
    type: Schema.Literal("checkbox"),
    label: Schema.String,
    default: Schema.OptionFromOptionalKey(Schema.Boolean)
  })
])
export type ManifestPreference = typeof ManifestPreference.Type

export const ManifestTool = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  description: Schema.String
})
export interface ManifestTool extends Schema.Schema.Type<typeof ManifestTool> {}

export const Manifest = Schema.Struct({
  commands: Schema.Array(ManifestCommand),
  preferences: Schema.Array(ManifestPreference),
  tools: Schema.Array(ManifestTool)
})
export interface Manifest extends Schema.Schema.Type<typeof Manifest> {}

export const GeneratedFile = Schema.Struct({
  /** Relative to the extension root. */
  path: Schema.String,
  contents: Schema.String
})
export interface GeneratedFile extends Schema.Schema.Type<typeof GeneratedFile> {}

/* -------------------------------------------------------------------------- */
/* Names                                                                      */
/* -------------------------------------------------------------------------- */

/** Raycast-safe identifier for arguments / preferences (`dry-run` → `dryRun`). */
export const identifier = Spec.identifier

const choiceOptions = (param: ParamSpec) => choicesOf(param).map((choice) => ({ title: choice, value: choice }))

const describe = (leaf: LeafSpec): string =>
  pipe(
    leaf.command.description,
    Option.orElse(() => leaf.command.shortDescription),
    Option.getOrElse(() => `Run ${leaf.command.path.join(" ")}`)
  )

/* -------------------------------------------------------------------------- */
/* Launch arguments                                                           */
/* -------------------------------------------------------------------------- */

/** Raycast accepts at most three launch arguments per command. */
const MAX_QUICK_ARGUMENTS = 3

const isQuickArgument = (field: ParamSpec): boolean =>
  isRequired(field) &&
  isFormField(field) &&
  !isVariadic(field) &&
  Match.value(field.type).pipe(
    Match.tags({ String: () => true, Int: () => true, Number: () => true, Secret: () => true, Choice: () => true }),
    Match.orElse(() => false)
  )

/** The (≤3) fields promoted to Raycast launch arguments for a leaf. */
export const quickArguments = (config: RaycastConfig, leaf: LeafSpec): ReadonlyArray<ParamSpec> =>
  Bool.match(config.options.commands.quickArguments, {
    onFalse: () => [],
    onTrue: () => leaf.fields.filter(isQuickArgument).slice(0, MAX_QUICK_ARGUMENTS)
  })

const toArgument = (field: ParamSpec): ManifestArgument => {
  const base = { name: identifier(field.name), placeholder: field.title, required: true } as const
  return Match.value(field.type).pipe(
    Match.withReturnType<ManifestArgument>(),
    Match.tag("Secret", () => ({ ...base, type: "password" })),
    Match.tag("Choice", () => ({ ...base, type: "dropdown", data: choiceOptions(field) })),
    Match.orElse(() => ({ ...base, type: "text" }))
  )
}

/* -------------------------------------------------------------------------- */
/* Preferences                                                                */
/* -------------------------------------------------------------------------- */

type PreferenceBase = Pick<ManifestPreference, "name" | "title" | "description" | "required">

/** Preferences are single-valued (multi-valued flags are rejected by `defineConfig`). */
const textDefault = (param: ParamSpec): Option.Option<string> => Option.flatMap(defaultTokens(param), Arr.head)

/** One factory per Raycast preference type. */
export const Preference = {
  makeTextField: (base: PreferenceBase, fallback: Option.Option<string>): ManifestPreference => ({
    ...base,
    type: "textfield",
    default: fallback
  }),
  makePassword: (base: PreferenceBase, fallback: Option.Option<string>): ManifestPreference => ({
    ...base,
    type: "password",
    default: fallback
  }),
  makeFile: (base: PreferenceBase, fallback: Option.Option<string>): ManifestPreference => ({
    ...base,
    type: "file",
    default: fallback
  }),
  makeDirectory: (base: PreferenceBase, fallback: Option.Option<string>): ManifestPreference => ({
    ...base,
    type: "directory",
    default: fallback
  }),
  makeDropdown: (
    base: PreferenceBase,
    fallback: Option.Option<string>,
    data: ReadonlyArray<{ readonly title: string; readonly value: string }>
  ): ManifestPreference => ({ ...base, type: "dropdown", default: fallback, data }),
  /** Checkboxes always have a value, so they are never required. */
  makeCheckbox: (base: PreferenceBase, label: string, fallback: Option.Option<boolean>): ManifestPreference => ({
    ...base,
    type: "checkbox",
    required: false,
    label,
    default: fallback
  })
}

const preferenceFor = (param: ParamSpec): ManifestPreference => {
  const base: PreferenceBase = {
    name: identifier(param.name),
    title: param.title,
    description: Option.getOrElse(param.description, () => `Value for --${param.name}`),
    required: isRequired(param)
  }
  return Match.value(param.type).pipe(
    Match.tag("Secret", () => Preference.makePassword(base, textDefault(param))),
    Match.tag("Boolean", () =>
      Preference.makeCheckbox(base, param.title, Option.map(defaultTokens(param), Arr.contains(String(true))))
    ),
    Match.tag("Choice", () => Preference.makeDropdown(base, textDefault(param), choiceOptions(param))),
    Match.tag("Path", ({ pathType }) =>
      Match.value(pathType).pipe(
        Match.when("directory", () => Preference.makeDirectory(base, textDefault(param))),
        Match.orElse(() => Preference.makeFile(base, textDefault(param)))
      )
    ),
    Match.orElse(() => Preference.makeTextField(base, textDefault(param)))
  )
}

/* -------------------------------------------------------------------------- */
/* Manifest                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_MODE: Mode = "view"

const modeOf = (leaf: LeafSpec): Mode =>
  Option.getOrElse(Option.fromUndefinedOr(leaf.command.meta.mode), () => DEFAULT_MODE)

const commandLeaves = (config: RaycastConfig): Array<LeafSpec> =>
  Include.when(showsLeaves(config.options), () => leaves(config.spec)).flat()

/** A command's own `tool` annotation wins over the config-wide `ai.tools`. */
const isTool =
  (config: RaycastConfig) =>
  (leaf: LeafSpec): boolean =>
    Option.getOrElse(Option.fromUndefinedOr(leaf.command.meta.tool), () => config.options.ai.tools)

export const toolLeaves = (config: RaycastConfig): Array<LeafSpec> => leaves(config.spec).filter(isTool(config))

const showsBrowserFor = (config: RaycastConfig): boolean => showsBrowser(config.options, config.spec)

const leafCommand = (config: RaycastConfig, leaf: LeafSpec): ManifestCommand => ({
  name: commandName(leaf.command.path),
  title: leafTitle(leaf),
  subtitle: Option.orElse(Option.fromUndefinedOr(leaf.command.meta.subtitle), () =>
    Option.some(config.spec.root.title)
  ),
  description: describe(leaf),
  mode: modeOf(leaf),
  icon: Option.fromUndefinedOr(leaf.command.meta.icon),
  keywords: Option.fromUndefinedOr(leaf.command.meta.keywords),
  arguments: Arr.match(quickArguments(config, leaf).map(toArgument), { onEmpty: Option.none, onNonEmpty: Option.some })
})

const browserCommand = (config: RaycastConfig): ManifestCommand => {
  const { root } = config.spec
  return {
    name: config.options.commands.browserName,
    title: `Browse ${root.title}`,
    subtitle: Option.none(),
    description: Option.getOrElse(root.description, () => `Browse all ${root.name} commands`),
    mode: DEFAULT_MODE,
    icon: Option.fromUndefinedOr(root.meta.icon),
    keywords: Option.none(),
    arguments: Option.none()
  }
}

export const manifest = (config: RaycastConfig): Manifest => ({
  commands: [
    ...Include.when(showsBrowserFor(config), () => browserCommand(config)),
    ...commandLeaves(config).map((leaf) => leafCommand(config, leaf))
  ],
  preferences: pipe(
    leaves(config.spec).flatMap((leaf) => leaf.fields),
    Arr.filter(isPreference),
    Arr.dedupeWith((a, b) => a.name === b.name),
    Arr.map(preferenceFor)
  ),
  tools: toolLeaves(config).map((leaf) => ({
    name: commandName(leaf.command.path),
    title: leafTitle(leaf),
    description: describe(leaf)
  }))
})

/* -------------------------------------------------------------------------- */
/* Stub files                                                                 */
/* -------------------------------------------------------------------------- */

export const GENERATED_MARKER =
  "// @generated by effect-cli-raycast — `ecr sync` rewrites this file; `ecr eject` to own it."

/** A file is the generator's to rewrite or delete while it starts with this marker. */
export const isGenerated = (contents: string): boolean => contents.startsWith(GENERATED_MARKER)

/** Where Raycast looks for command entry points, relative to the extension root. */
export const SOURCE_DIR = "src"
/** Where Raycast looks for AI tool entry points. */
export const TOOLS_DIR = `${SOURCE_DIR}/tools`
/** Extensions Raycast accepts for entry points, in the order a stub is looked up. */
export const SOURCE_EXTENSIONS: ReadonlyArray<string> = [".tsx", ".ts", ".jsx", ".js"]

const commandStub = (config: RaycastConfig, name: string, entry: string): GeneratedFile => ({
  path: `${SOURCE_DIR}/${name}.tsx`,
  contents: Source.lines(
    GENERATED_MARKER,
    `import { app } from ${Source.string(config.options.codegen.appModule)}`,
    "",
    `export default ${entry}`,
    ""
  )
})

const leafEntry = (leaf: LeafSpec): string => {
  const key = Source.string(pathKey(leaf.command.path))
  return Match.value(modeOf(leaf)).pipe(
    Match.when("no-view", () => `app.noView(${key})`),
    Match.when("view", () => `app.view(${key})`),
    Match.exhaustive
  )
}

const scalarType = (param: ParamSpec): string =>
  Match.value(param.type).pipe(
    Match.tag("Boolean", () => "boolean"),
    Match.tags({ Int: () => "number", Number: () => "number" }),
    Match.tag("Choice", ({ choices }) =>
      Arr.match(choices, { onEmpty: () => "string", onNonEmpty: (all) => all.map(Source.string).join(" | ") })
    ),
    Match.orElse(() => "string")
  )

const toolInputType = (param: ParamSpec): string =>
  Match.value(param).pipe(
    Match.when(isMultiValued, () => `Array<${scalarType(param)}>`),
    Match.orElse(() => scalarType(param))
  )

/** Booleans can always be omitted: the runtime sends `false`. */
const isOptionalInput = (param: ParamSpec): boolean => !isRequired(param) || isBoolean(param)

const propertyName = (param: ParamSpec): string => {
  const key = Source.propertyKey(identifier(param.name))
  return Bool.match(isOptionalInput(param), { onTrue: () => `${key}?`, onFalse: () => key })
}

const toolProperty = (param: ParamSpec): Array<string> => [
  ...Source.jsDoc(
    Option.orElse(param.description, () => Option.some(param.title)),
    "  "
  ),
  `  ${propertyName(param)}: ${toolInputType(param)}`
]

/** AI tools never see secrets or preference-backed params. */
const isToolInput = (param: ParamSpec): boolean => isFormField(param) && !isSecret(param)

const toolStub = (config: RaycastConfig, leaf: LeafSpec): GeneratedFile => {
  const key = Source.string(pathKey(leaf.command.path))
  return {
    path: `${TOOLS_DIR}/${commandName(leaf.command.path)}.ts`,
    contents: Source.lines(
      GENERATED_MARKER,
      `import { app } from ${Source.string(Source.fromSubdirectory(config.options.codegen.appModule))}`,
      "",
      "type Input = {",
      leaf.fields.filter(isToolInput).flatMap(toolProperty),
      "}",
      "",
      Source.jsDoc(Option.some(describe(leaf)), ""),
      "export default async function tool(input: Input) {",
      `  return app.tool(${key}, input)`,
      "}",
      Option.match(confirmation(config, leaf.command), {
        onNone: () => [],
        onSome: () => ["", `export const confirmation = app.confirmation<Input>(${key})`]
      }),
      ""
    )
  }
}

export const stubs = (config: RaycastConfig): Array<GeneratedFile> => [
  ...Include.when(showsBrowserFor(config), () =>
    commandStub(config, config.options.commands.browserName, "app.browser()")
  ),
  ...commandLeaves(config).map((leaf) => commandStub(config, commandName(leaf.command.path), leafEntry(leaf))),
  ...toolLeaves(config).map((leaf) => toolStub(config, leaf))
]
