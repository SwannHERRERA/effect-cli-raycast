import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Schema } from "effect"
import { Command } from "effect/cli"
import { fileURLToPath } from "node:url"
import { cli } from "./cli.ts"

/** The version printed by `ecr --version` is the package's own, not a copy that can drift. */
const PackageVersion = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const { version } = yield* Schema.decodeEffect(PackageVersion)(
    yield* fs.readFileString(fileURLToPath(new URL("../package.json", import.meta.url)))
  )
  yield* Command.run(cli, { version })
})

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
