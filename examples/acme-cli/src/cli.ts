/**
 * A sample Effect v4 CLI. Nothing here knows about Raycast except the optional
 * `Raycast.Meta` annotations, which are plain `Command.annotate` metadata.
 */
import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { Raycast } from "effect-cli-raycast/config"

const greet = Command.make(
  "greet",
  {
    name: Argument.String("name").pipe(Argument.withDescription("Who to greet")),
    shout: Flag.Boolean("shout").pipe(
      Flag.withAlias("s"),
      Flag.withDescription("Uppercase the greeting"),
      Flag.withDefault(false)
    ),
    times: Flag.Int("times").pipe(Flag.withDescription("Repeat count"), Flag.withDefault(1))
  },
  ({ name, shout, times }) =>
    Effect.gen(function* () {
      const line = `Hello, ${name}!`
      for (let i = 0; i < times; i++) yield* Console.log(shout ? line.toUpperCase() : line)
    })
).pipe(Command.withDescription("Say hello"), Command.annotate(Raycast.Meta, { keywords: ["hello", "hi"] }))

const deploy = Command.make(
  "deploy",
  {
    env: Flag.Literals("env", ["dev", "staging", "prod"]).pipe(Flag.withDescription("Target environment")),
    replicas: Flag.Int("replicas").pipe(Flag.withDescription("Instances to run"), Flag.withDefault(2)),
    dryRun: Flag.Boolean("dry-run").pipe(Flag.withDescription("Plan only")),
    label: Flag.KeyValuePair("label").pipe(Flag.withDescription("Extra labels"), Flag.optional),
    services: Argument.String("services").pipe(
      Argument.withDescription("Services to deploy"),
      Argument.variadic({ min: 1 })
    )
  },
  (input) =>
    Effect.gen(function* () {
      yield* Console.log(`Deploying ${input.services.join(", ")} to ${input.env} (${input.replicas} replicas)`)
      for (const service of input.services) {
        yield* Effect.sleep("300 millis")
        yield* Console.log(`  ✓ ${service}${input.dryRun ? " (dry run)" : ""}`)
      }
      if (Option.isSome(input.label)) yield* Console.log(`Labels: ${JSON.stringify(input.label.value)}`)
    })
).pipe(
  Command.withDescription("Deploy services to an environment"),
  Command.annotate(Raycast.Meta, { confirm: "Deploy now?", tool: true })
)

const logs = Command.make(
  "logs",
  {
    since: Flag.Date("since").pipe(Flag.withDescription("Only logs after this date"), Flag.optional),
    lines: Flag.Int("lines").pipe(Flag.withAlias("n"), Flag.withDefault(5)),
    service: Argument.String("service")
  },
  ({ lines, service, since }) =>
    Effect.gen(function* () {
      const from = Option.match(since, { onNone: () => "the beginning", onSome: (date) => date.toISOString() })
      yield* Console.log(`# ${service} logs since ${from}`)
      for (let i = 1; i <= lines; i++) yield* Effect.log(`${service}: request ${i} served`)
    })
).pipe(Command.withShortDescription("Show recent logs"))

const migrate = Command.make(
  "migrate",
  {
    steps: Flag.Int("steps").pipe(Flag.withDescription("Number of migrations"), Flag.optional),
    schema: Flag.File("schema").pipe(Flag.withDescription("Schema file"), Flag.optional)
  },
  ({ steps }) => Console.log(`Applied ${Option.getOrElse(steps, () => 3)} migration(s)`)
).pipe(Command.withDescription("Run pending migrations"))

const db = Command.make("db").pipe(
  Command.withDescription("Database commands"),
  Command.withSharedFlags({
    token: Flag.Redacted("token").pipe(Flag.withDescription("API token"))
  }),
  Command.withSubcommands([migrate])
)

export const cli = Command.make("acme").pipe(
  Command.withDescription("Acme platform CLI"),
  Command.withSubcommands([greet, deploy, logs, { group: "Data", commands: [db] }])
)

export const version = "1.0.0"
