<img src="assets/icon.svg" width="64" height="64" alt="">

# effect-cli-raycast

Turn an [Effect v4](https://effect.website) `effect/cli` command tree into a Raycast extension.
Flags, arguments, subcommands, defaults, choices and descriptions are reflected from the CLI.
Each command becomes a Raycast form; running it builds the argv and executes the CLI
in-process or as a binary.

```
packages/
  core/     @effect-cli-raycast/core   reflection → CliSpec IR, argv builder, runners, manifest
  raycast/  effect-cli-raycast         React runtime: makeRaycast, forms, browser, results
  gen/      @effect-cli-raycast/gen    `ecr` CLI: sync / eject / inspect (itself an effect/cli app)
examples/
  acme-cli/      a sample Effect CLI
  acme-raycast/  the Raycast extension generated from it
```

## Usage

**1. Export your CLI** (no Raycast dependency required; annotations are optional):

```ts
// my-cli/src/cli.ts
export const cli = Command.make("acme").pipe(Command.withSubcommands([deploy, logs, db]))

// optional per-command metadata
deploy.pipe(Command.annotate(Raycast.Meta, { confirm: "Deploy now?", tool: true, mode: "view" }))
```

**2. Configure the extension** — `raycast.config.ts` (Node-safe, read by `ecr` and the runtime):

```ts
import { cli, version } from "my-cli"
import { defineConfig, Runner } from "effect-cli-raycast/config"

export default defineConfig(cli, {
  version,
  runner: Runner.inProcess(cli, { version }), // or Runner.exec({ bin: "/opt/homebrew/bin/acme" })
  commands: { strategy: "both", quickArguments: true }, // "leaves" | "browser" | "both"
  form: { persistence: "storeValue", drafts: true }, // "storeValue" | "localStorage" | "none"
  feedback: { mode: "toast", confirm: ["db migrate"] }, // "toast" | "hud" | "silent"
  output: { view: "detail", format: "code" }, // "detail" | "clipboard" | "paste" | "none"
  history: { enabled: true, max: 50 },
  preferences: ["token"], // flags provided by Raycast preferences
  ai: { tools: false }, // emit Raycast AI tools for every leaf
  overrides: { logs: { title: "Tail Logs" } }
})
```

**3. Create the app value** — `src/app.ts`; React-level extension points live here:

```ts
import { makeRaycast } from "effect-cli-raycast"
import config from "../raycast.config"

export const app = makeRaycast(config, {
  widgets: { textarea: MyTextArea },         // replace a widget kind
  fields: { "acme.deploy.env": EnvPicker },  // replace one field (by id or param name)
  renderResult: (ctx) => <MyResult {...ctx} />,
  onResult: (ctx) => Effect.sync(() => track(ctx.leaf.command.path))
})
```

**4. Generate and build:**

```sh
ecr inspect          # what the generator sees
ecr sync             # write package.json commands/arguments/preferences/tools + src stubs
ecr eject deploy     # write an editable form (app.customView) for one command; sync leaves it alone
ray develop
```

Generated stubs are one line (`export default app.view("deploy")`) and safe to regenerate.
A file is owned by the generator while it starts with the `@generated` marker.

### Composition

Everything inside the runtime is an `Effect`; `view` / `noView` / `tool` / `confirmation` are the
only places where it becomes what Raycast expects.

```ts
// input is keyed by camelCased param name, like an AI tool's
const result = yield* app.run("deploy", { env: "dev", services: ["api"] })

export default app.customView("db migrate", (form) => <Form …>{/* your fields */}</Form>)
```

## Param → widget

| Effect CLI                                                | Raycast                                                        |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| `Flag.Boolean`                                            | Checkbox (no default ⇒ always sent as `--flag=false`/`--flag`) |
| `Literals` / `ChoiceWithValue`                            | Dropdown (TagPicker if variadic)                               |
| `String` / `Int` / `Finite`                               | TextField (+ numeric validation)                               |
| `Date`                                                    | DatePicker                                                     |
| `File` / `Directory` / `Path` / `FileText` / `FileSchema` | FilePicker                                                     |
| `Redacted`                                                | PasswordField (never persisted, masked in history)             |
| `KeyValuePair`, variadic                                  | TextArea, one value per line                                   |

## Development

```sh
pnpm install
pnpm test     # vitest (core + gen), includes real-parser round-trip contract tests
pnpm check    # tsc for all packages
pnpm --filter acme-raycast sync && pnpm --filter acme-raycast build
```

See [docs/DESIGN.md](docs/DESIGN.md) for the research behind the design.
