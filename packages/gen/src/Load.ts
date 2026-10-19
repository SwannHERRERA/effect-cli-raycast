import { Config } from "@effect-cli-raycast/core"
import { Effect, Match, Predicate, Schema } from "effect"
import { createJiti } from "jiti"

export class LoadError extends Schema.TaggedError<LoadError>()("LoadError", {
  file: Schema.String,
  reason: Schema.String,
  cause: Schema.Defect()
}) {
  override get message() {
    return `Cannot load ${this.file}: ${this.reason}`
  }
}

const reasonOf = (cause: unknown): string =>
  Match.value(cause).pipe(
    Match.when(Predicate.isError, (error) => error.message),
    Match.orElse(String)
  )

const loadError = (file: string) => (cause: unknown) => new LoadError({ file, reason: reasonOf(cause), cause })

const notAConfig = (file: string) => (exported: unknown) =>
  new LoadError({ file, reason: "default export must be the result of defineConfig(cli, options)", cause: exported })

/** Import a TypeScript config module whose default export is `defineConfig(cli, options)`. */
export const loadConfig = Effect.fn("Load.loadConfig")(function* (file: string) {
  const exported = yield* Effect.tryPromise({
    try: (): Promise<unknown> => createJiti(import.meta.url, { interopDefault: true }).import(file, { default: true }),
    catch: loadError(file)
  })
  const definition = yield* Effect.succeed(exported).pipe(Effect.filterOrFail(Config.isDefinition, notAConfig(file)))
  return yield* definition.resolve.pipe(Effect.mapError(loadError(file)))
})
