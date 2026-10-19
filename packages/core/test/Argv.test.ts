import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Effect, Option, Result } from "effect"
import { Argv, Runner } from "#src/index"
import { acme, received } from "./fixture.ts"
import { leaf, submit } from "./helpers.ts"

const runner = Runner.inProcess(acme, { version: "1.0.0" })

const buildOk = (path: string, raw: Readonly<Record<string, unknown>>): Argv.Argv =>
  Argv.build(
    leaf(path),
    Result.getOrThrowWith(submit(leaf(path), raw), (errors) => new Error(Object.values(errors).join(", ")))
  )

/** Build argv from form values, run it through the real parser, return what the handler saw. */
const roundTrip = Effect.fnUntraced(function* (path: string, raw: Readonly<Record<string, unknown>>) {
  received.length = 0
  const argv = Argv.toArgs(buildOk(path, raw))
  const result = yield* runner.run(argv)
  assert.strictEqual(result.exitCode, Runner.ExitCodes.Success, result.stderr)
  return { argv, input: received[0]?.input as Record<string, unknown> }
})

describe("Argv", () => {
  it("validates required, numeric and choice fields", () => {
    const result = submit(leaf("deploy"), { "acme.deploy.replicas": "x", "acme.deploy.env": "qa" })
    const expected: Record<string, string> = {
      "acme.deploy.env": "Must be one of: dev, staging, prod",
      "acme.deploy.replicas": "Must be an integer",
      "acme.deploy.@services": "Required"
    }
    assert.deepStrictEqual(Result.getFailure(result), Option.some(expected))
  })

  it.effect("round-trips a full deploy form through the real parser", () =>
    Effect.gen(function* () {
      const { argv, input } = yield* roundTrip("deploy", {
        "acme.profile": "work",
        "acme.deploy.env": "prod",
        "acme.deploy.force": true,
        "acme.deploy.replicas": "5",
        "acme.deploy.tag": "--weird value",
        "acme.deploy.label": "team=core\nowner=ops",
        "acme.deploy.token": "s3cr3t",
        "acme.deploy.dir": [],
        "acme.deploy.@services": "api\n-web\n"
      })
      assert.deepStrictEqual(argv, [
        "--profile=work",
        "deploy",
        "--env=prod",
        "--force",
        "--replicas=5",
        "--tag=--weird value",
        "--label=team=core",
        "--label=owner=ops",
        "--token=s3cr3t",
        "--",
        "api",
        "-web"
      ])
      assert.deepStrictEqual(input, {
        env: "prod",
        force: true,
        replicas: 5,
        tag: Option.some("--weird value"),
        label: Option.some({ team: "core", owner: "ops" }),
        token: Option.some("s3cr3t"),
        dir: Option.none(),
        services: ["api", "-web"]
      })
    })
  )

  it.effect("omits values equal to their defaults and encodes false booleans", () =>
    Effect.gen(function* () {
      const { argv, input } = yield* roundTrip("logs", {
        "acme.profile": "default",
        "acme.logs.follow": false,
        "acme.logs.since": new Date("2026-01-02T03:04:05.000Z"),
        "acme.logs.@service": "api"
      })
      assert.deepStrictEqual(argv, [
        "--profile=default",
        "logs",
        "--follow=false",
        "--since=2026-01-02T03:04:05.000Z",
        "api"
      ])
      assert.strictEqual(input.follow, false)
      assert.deepStrictEqual(input.since, Option.some(new Date("2026-01-02T03:04:05.000Z")))
    })
  )

  it.effect("places shared flags at their owner's level", () =>
    Effect.gen(function* () {
      const { argv, input } = yield* roundTrip("db migrate", {
        "acme.db.url": "pg://x",
        "acme.db.migrate.steps": "2"
      })
      assert.deepStrictEqual(argv, ["--profile=default", "db", "--url=pg://x", "migrate", "--steps=2"])
      assert.deepStrictEqual(input, { steps: Option.some(2) })
    })
  )

  it.effect("always emits booleans that have no default", () =>
    Effect.gen(function* () {
      const { argv, input } = yield* roundTrip("deploy", {
        "acme.deploy.env": "dev",
        "acme.deploy.force": false,
        "acme.deploy.@services": "api"
      })
      assert.deepStrictEqual(argv, ["--profile=default", "deploy", "--env=dev", "--force=false", "--replicas=3", "api"])
      assert.strictEqual(input.force, false)
    })
  )

  it("formats a shell-safe, redacted command line", () => {
    const argv = buildOk("deploy", {
      "acme.profile": "",
      "acme.deploy.replicas": "",
      "acme.deploy.env": "dev",
      "acme.deploy.force": true,
      "acme.deploy.token": "s3cr3t",
      "acme.deploy.@services": "my api"
    })
    assert.strictEqual(Argv.commandLine(leaf("deploy"), argv), "acme deploy --env=dev --force --token=•••• 'my api'")
  })
})
