import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import { Runner } from "#src/index"
import { acme } from "./fixture.ts"

const runner = Runner.inProcess(acme, { version: "1.0.0" })

describe("Runner.inProcess", () => {
  it.effect("captures Console and Effect.log output", () =>
    Effect.gen(function* () {
      const chunks: Array<string> = []
      const result = yield* runner.run(["logs", "api"], {
        onOutput: (output) => Effect.sync(() => chunks.push(output.text))
      })
      assert.strictEqual(result.exitCode, Runner.ExitCodes.Success)
      assert.include(result.stdout, "ran logs")
      assert.include(result.stdout, "log line from Effect.log")
      // Console.log and Effect.log arrive as separate live chunks.
      assert.deepStrictEqual(
        chunks.filter((chunk) => chunk.includes("ran logs") || chunk.includes("Effect.log")).length,
        2
      )
    })
  )

  it.effect("renders parse errors with help and exits 1", () =>
    Effect.gen(function* () {
      const result = yield* runner.run(["deploy", "--env=nope", "api"])
      assert.strictEqual(result.exitCode, 1)
      assert.include(result.stdout + result.stderr, "env")
      assert.notInclude(result.stdout + result.stderr, "\u001b[")
    })
  )

  it.effect("renders unexpected handler failures", () =>
    Effect.gen(function* () {
      const result = yield* runner.run(["fail"])
      assert.strictEqual(result.exitCode, 1)
      assert.include(result.stderr, "boom")
    })
  )
})

describe("Runner.exec", () => {
  it.effect("spawns a binary and captures both streams", () =>
    Effect.gen(function* () {
      const exec = Runner.exec({
        bin: process.execPath,
        prefixArgs: ["-e", "console.log(process.argv.slice(1).join(','));console.error('warn');process.exit(3)"]
      })
      const result = yield* exec.run(["a", "b c"])
      assert.strictEqual(result.exitCode, 3)
      assert.strictEqual(result.stdout.trim(), "a,b c")
      assert.strictEqual(result.stderr.trim(), "warn")
    })
  )

  it.effect("fails with RunnerError when the binary is missing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Runner.exec({ bin: "/nonexistent/acme" }).run([]))
      assert.strictEqual(error._tag, "RunnerError")
    })
  )
})
