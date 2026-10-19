import { Console, Effect, Option, Redacted } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { Raycast } from "#src/index"

export const received: Array<{ readonly command: string; readonly input: unknown }> = []

const record = (command: string) => (input: unknown) =>
  Effect.gen(function* () {
    received.push({ command, input })
    yield* Console.log(`ran ${command}`)
  })

export const deploy = Command.make(
  "deploy",
  {
    env: Flag.Literals("env", ["dev", "staging", "prod"]).pipe(Flag.withDescription("Target environment")),
    force: Flag.Boolean("force").pipe(Flag.withAlias("f")),
    replicas: Flag.Int("replicas").pipe(Flag.withDefault(3)),
    tag: Flag.String("tag").pipe(Flag.optional),
    label: Flag.KeyValuePair("label").pipe(Flag.optional),
    token: Flag.Redacted("token").pipe(Flag.optional),
    dir: Flag.Directory("dir").pipe(Flag.optional),
    services: Argument.String("services").pipe(Argument.variadic({ min: 1 }))
  },
  (input) =>
    record("deploy")({
      ...input,
      token: Option.map(input.token, Redacted.value)
    })
).pipe(
  Command.withDescription("Deploy services"),
  Command.annotate(Raycast.Meta, { icon: "rocket.png", confirm: true })
)

export const logs = Command.make(
  "logs",
  {
    follow: Flag.Boolean("follow").pipe(Flag.withDefault(true)),
    since: Flag.Date("since").pipe(Flag.optional),
    service: Argument.String("service")
  },
  (input) =>
    Effect.gen(function* () {
      yield* record("logs")(input)
      yield* Effect.log("log line from Effect.log")
    })
).pipe(Command.withShortDescription("Tail logs"))

export const migrate = Command.make(
  "migrate",
  {
    steps: Flag.Int("steps").pipe(Flag.optional)
  },
  record("db migrate")
)

export const fail = Command.make("fail", {}, () => Effect.fail(new Error("boom")))

export const db = Command.make("db").pipe(
  Command.withSharedFlags({ url: Flag.String("url").pipe(Flag.withDescription("Database URL")) }),
  Command.withSubcommands([migrate])
)

export const secret = Command.make(
  "secret",
  { verbose: Flag.Boolean("verbose").pipe(Flag.withHidden) },
  () => Effect.void
).pipe(Command.unlisted)

export const acme = Command.make("acme").pipe(
  Command.withDescription("Acme platform CLI"),
  Command.withSharedFlags({ profile: Flag.String("profile").pipe(Flag.withDefault("default")) }),
  Command.withSubcommands([deploy, logs, { group: "Data", commands: [db] }, fail, secret])
)
