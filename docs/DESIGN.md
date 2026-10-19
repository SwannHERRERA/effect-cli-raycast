# effect-cli-raycast — Design

Generate a Raycast extension from an Effect v4 `effect/cli` command tree.

```ts
// my-cli/src/cli.ts
export const cli = Command.make("acme").pipe(Command.withSubcommands([deploy, logs, db]))

// my-raycast/src/app.ts
import { cli } from "my-cli"
import { makeRaycast } from "effect-cli-raycast"
export const app = makeRaycast(cli, { version: "1.0.0" /* options */ })

// my-raycast/src/deploy.tsx            (generated, 1 line, safe to regenerate)
export default app.view(["deploy"])
```

## 1. Research findings

### Effect v4 CLI (`effect@4.0.2`, `effect/cli`) — what is reflectable

| Data                                                                                                                                                 | Where                                                         | Public?                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `description`, `shortDescription`, `alias`, `examples`, `unlisted`                                                                           | `Command`                                                     | yes                                                                                                                                                            |
| `subcommands: { group, commands }[]`                                                                                                                 | `Command`                                                     | yes                                                                                                                                                            |
| `annotations: Context`                                                                                                                               | `Command.annotate`                                            | yes — our extension point                                                                                                                                      |
| flags / arguments / declaration tree                                                                                                                 | `impl.config` (`flags`, `arguments`, `orderedParams`, `tree`) | **internal** (runtime-readable; used by the built-in wizard)                                                                                                   |
| shared parent flags                                                                                                                                  | `impl.contextConfig`                                          | internal                                                                                                                                                       |
| param name, aliases, description, hidden, kind                                                                                                       | `Param.extractSingleParams(p)` → `Single`                     | exported (`@internal` tag)                                                                                                                                     |
| optional / variadic min/max                                                                                                                          | `Param.getParamMetadata(p)`                                   | exported (`@internal` tag)                                                                                                                                     |
| primitive `_tag` (`Boolean`, `String`, `Int`, `Finite`, `Date`, `Choice`, `Path`, `Redacted`, `FileText`, `FileParse`, `FileSchema`, `KeyValuePair`) | `single.primitiveType._tag`                                   | yes                                                                                                                                                            |
| choice keys / path type (`file`/`directory`/`either`)                                                                                                | `Primitive.getChoiceKeys`, `Primitive.getPathType`            | exported (`@internal` tag)                                                                                                                                     |
| default values                                                                                                                                       | closure inside `withDefault`                                  | **not stored** → recovered by `param.parse({ flags: {}, arguments: [] })` (verified: `replicas → 3`, `force → false`, optional → `None`, required → `Failure`) |
| global flags                                                                                                                                         | `Command.withGlobalFlags`, `GlobalFlag.Setting/Action`        | partly                                                                                                                                                         |

Precedent: `effect/cli/internal/wizard.ts` does exactly our job for a terminal —
walk tree → prompt per primitive → build argv → `Command.runWith(cmd)(argv)`.
We mirror it with Raycast forms instead of terminal prompts.

**Risk:** `config` is internal. Mitigation: a single `Introspect` adapter module, a
contract test suite pinned to the `effect` version, and an upstream proposal for a
public `Command.getParams` / reflection API.

### Raycast (`@raycast/api@2.8.2`, `@raycast/utils@2.3.3`)

- Commands **must be static** in `package.json` and each needs `src/<name>.tsx`
  (build fails otherwise) → a **codegen/sync step is mandatory**; the UI itself can
  be runtime-driven.
- Manifest `arguments`: max 3, `text | password | dropdown`, all strings.
- `preferences`: extension- or command-level; `textfield | password | checkbox | dropdown | file | directory | appPicker`.
- Form widgets: `TextField`, `PasswordField`, `TextArea`, `Checkbox`, `DatePicker`,
  `Dropdown`, `TagPicker`, `FilePicker` (+ `canChooseDirectories`,
  `allowMultipleSelection`), `storeValue`, `enableDrafts`, `useForm` validation.
- Feedback: `showToast` (mutable, Animated→Success/Failure), `showHUD`,
  `closeMainWindow`, `confirmAlert`, `showFailureToast`.
- Storage: `LocalStorage` (primitives), `Cache` (sync, strings), `useLocalStorage`,
  `useCachedState`, `useFrecencySorting`.
- Exec: Node `child_process` available; `useExec` default timeout **10s**; Raycast
  does **not** inherit the shell PATH (no `/opt/homebrew/bin`).
- Bundling: esbuild, `platform: node`, target node 22, CJS, everything in
  `node_modules` bundled (shared chunk across entries) → importing an Effect CLI
  **in-process works**. Native `.node` addons rejected. React 19.
- AI tools: `tools[]` in manifest + `src/tools/<name>.ts`, input schema extracted from
  **static TS types** at build time → tools need generated, concretely typed files.

## 2. Architecture

```
effect-cli-raycast/
  packages/
    core/      # no React. Effect-based.
      Introspect   — the only module touching internals (config, Param, Primitive)
      Spec         — serializable IR: CommandSpec / ParamSpec (pure data, JSON-able)
      Field        — Schema codecs: widget / tool / preference value ⇄ Tokens (+ validation)
      Argv         — Tokens per field → Arg[] (subcommand / flag / switch / `--` / positional)
      Runner       — InProcess (Command.runWith + captured Console/Stdio) | Exec (spawn bin)
      Annotations  — Raycast metadata keys usable from the CLI side via Command.annotate
    raycast/   # React runtime for Raycast
      makeRaycast(cli, options) → RaycastApp   (the "variable" you pass around)
      <CommandForm/> <CommandBrowser/> <ResultView/> widget registry, hooks
    gen/       # `ecr` — itself an effect/cli app (dogfooding)
      ecr sync   — writes package.json commands/arguments/preferences/tools + stub files
      ecr eject  — writes a fully expanded, editable JSX form for a command path
  examples/
    acme-cli/       # sample Effect CLI
    acme-raycast/   # generated Raycast extension
```

### Pipeline

```
Command tree ──Introspect──▶ CliSpec (IR) ──┬─▶ gen: manifest + stubs (+ AI tool files)
                                            └─▶ raycast runtime: Form fields
Widget values ──Field──▶ Tokens ──Argv──▶ Arg[] ──Runner──▶ { exitCode, stdout, stderr, duration } ──▶ feedback/output
```

The IR is the contract. Everything downstream (codegen, React, AI tools, tests) reads
`CliSpec`, never the Effect internals.

```ts
interface CommandSpec {
  path: string[]
  name: string
  title: string
  description?: string
  alias?: string
  examples: Example[]
  group?: string
  params: ParamSpec[] // own params (leaf) or context params (parent)
  children: CommandSpec[]
  meta: RaycastMeta // from Command.annotate(Raycast.Meta, …)
}
interface ParamSpec {
  kind: "flag" | "argument"
  name: string
  aliases: string[]
  description?: string
  type:
    | "boolean"
    | "string"
    | "int"
    | "number"
    | "date"
    | "choice"
    | "path"
    | "secret"
    | "file-text"
    | "file-parse"
    | "key-value"
  choices?: string[]
  pathType?: "file" | "directory" | "either"
  optional: boolean
  variadic?: { min?: number; max?: number }
  default?: unknown
  hidden: boolean
}
```

### Primitive → widget (default registry, overridable)

| ParamSpec         | Widget                                      | Notes                                                |
| ----------------- | ------------------------------------------- | ---------------------------------------------------- |
| boolean           | `Form.Checkbox`                             | emits `--flag` / `--flag=false`                      |
| string            | `Form.TextField`                            |                                                      |
| int / number      | `Form.TextField`                            | numeric validation via `useForm`                     |
| date              | `Form.DatePicker`                           | ISO string in argv                                   |
| choice            | `Form.Dropdown`                             |                                                      |
| path / file-*     | `Form.FilePicker`                           | `canChooseDirectories` from `pathType`               |
| secret (Redacted) | `Form.PasswordField`                        | never persisted; candidate for `password` preference |
| key-value         | `Form.TextArea`                             | one `k=v` per line                                   |
| variadic string   | `Form.TextArea` (line-split) or `TagPicker` |                                                      |
| variadic path     | `FilePicker allowMultipleSelection`         |                                                      |
| optional          | not required, unset = omitted from argv     |                                                      |

## 3. Options (`makeRaycast(cli, options)`)

```ts
makeRaycast(cli, {
  version: "1.0.0",
  runner: Runner.inProcess({ layer: NodeServices.layer })     // default
        | Runner.exec({ bin: "/opt/homebrew/bin/acme", env, timeout }),
  commands: {
    strategy: "leaves" | "browser" | "both",  // one Raycast command per leaf, a single tree browser, or both
    include?, exclude?,                        // path globs
    quickArguments: true                       // promote ≤3 required simple params to manifest arguments
  },
  form: {
    persistence: "storeValue" | "localStorage" | "none",   // remember last values
    drafts: true,                                           // Form enableDrafts
    widgets: { choice: MyDropdown },                        // registry override per type
    fields: { "deploy.env": { title: "Environment" } }      // per-param override
  },
  feedback: {
    mode: "toast" | "hud" | "silent",      // toast = Animated → Success/Failure with output action
    confirm: ["db.drop", "deploy"]         // confirmAlert before running
  },
  output: {
    view: "detail" | "clipboard" | "paste" | "none" | ((result) => ReactNode),
    format: "code" | "markdown" | "json"
  },
  history: { enabled: true, max: 50 },     // LocalStorage + useFrecencySorting, "re-run" list
  preferences: { fromFlags: ["token", "region"] },  // expose global/shared flags as Raycast preferences
  ai: { tools: false },                    // emit src/tools/*.ts with typed inputs
  overrides: { "deploy": { title, icon, mode: "no-view", subtitle } }
})
```

CLI-side opt-in metadata (keeps Raycast config next to the command):

```ts
deploy.pipe(Command.annotate(Raycast.Meta, { icon: "rocket.png", mode: "no-view", confirm: true }))
```

Precedence: `options.overrides` > `Raycast.Meta` annotation > reflected defaults.

## 4. Extensibility levels

1. **Options** — toggle behaviour (above).
2. **Registry / slots** — replace a widget type, a field, the result view, or wrap the form.
3. **Composition** — `app.spec(path)`, `app.run(path, values)`, `<app.Form path=… />`
   used inside your own hand-written Raycast command.
4. **Eject** — `ecr eject deploy` writes plain JSX you own; `ecr sync` stops touching it.

## 5. Running in Raycast — details

- **InProcess** (default): `Command.runWith(cli, { version, renderErrors: true })(argv)`
  with a capturing `Console` + `Stdio.layerTest`-style sink; `Terminal` replaced by a
  layer that fails prompts with a clear "interactive prompt not supported" error
  (`withFallbackPrompt` params are rendered as required fields instead).
  Pros: no PATH issues, no timeout, typed. Cons: handler code runs inside Raycast's
  Node process (native deps rejected by bundler).
- **Exec**: spawn absolute binary, explicit PATH/env, configurable timeout, stream
  stdout into a live-updating toast/detail.

## 6. Decisions (2026-10-19)

- Runners: **InProcess and Exec are both first-class** (same `Runner` interface, same test suite).
- Topology default: **both** — one Raycast command per leaf + a `Browse <cli>` tree command.
- Codegen default: **thin stubs + `ecr eject`**.
- Layout: **pnpm monorepo** (`packages/core`, `packages/raycast`, `packages/gen`, `examples/*`).

## 7. Implementation notes (learned while building v0.1)

- **Published `effect@4.0.5` strips `@internal` helpers from `.d.ts`**
  (`Param.extractSingleParams`, `getParamMetadata`, `Primitive.getChoiceKeys`,
  `getPathType`). `Introspect` therefore walks the _public_ `Param` node tags
  (`Single`/`Map`/`Transform`/`Optional`/`Variadic`) itself; only `config` /
  `contextConfig` and the `choiceKeys` / `pathType` fields are read from internals.
- **A bare `Flag.Boolean` (no `withDefault`) is required by the parser**
  (`Missing required flag: --x`), even though help output shows it as optional. The
  empty-parse probe reports this correctly; `Argv` always emits such flags
  (`--x` / `--x=false`).
- `Flag.KeyValuePair` is variadic internally (`--label a=1 --label b=2`).
- `effect/cli` lists ungrouped subcommands before grouped ones.
- Token encoding mirrors the wizard: `--name=value` for every flag value (safe for
  values starting with `-`), parent shared flags placed right after their command
  name, `--` before positionals when any starts with `-`. Covered by round-trip
  tests that run the real parser.
- `raycast.config.ts` must import from `effect-cli-raycast/config` (Node-safe
  re-export of core) because `ecr` loads it with jiti outside Raycast.
- `ray build` verified on the example: Effect + workspace TS sources bundle fine;
  the AI tool input schema (enum, descriptions, required) is extracted from the
  generated `type Input`. Dev bundles are ~950 KB per command.
- Commands marked `confirm` get `confirmAlert` in the UI and a `confirmation`
  export in their AI tool file.
