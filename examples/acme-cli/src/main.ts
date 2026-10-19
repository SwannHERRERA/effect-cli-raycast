import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { Command } from "effect/cli"
import { cli, version } from "./cli.ts"

cli.pipe(Command.run({ version }), Effect.provide(NodeServices.layer), NodeRuntime.runMain)
