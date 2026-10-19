/**
 * Everything the generator (`ecr sync`) and the runtime (`makeRaycast`) share.
 * Imports only Node-safe modules so `ecr` can load it outside Raycast.
 */
import { cli, version } from "acme-cli"
import { defineConfig, Runner } from "effect-cli-raycast/config"

export default defineConfig(cli, {
  version,
  // Both runners are first-class. In-process imports the Effect command;
  // exec spawns the installed binary (use an absolute path in Raycast).
  runner:
    process.env.ACME_BIN !== undefined
      ? Runner.exec({ bin: process.env.ACME_BIN })
      : Runner.inProcess(cli, { version }),
  commands: { strategy: "both", quickArguments: true },
  form: {
    persistence: "storeValue",
    drafts: true,
    fields: { services: { placeholder: "api\nweb" } }
  },
  feedback: { mode: "toast" },
  output: { view: "detail", format: "code" },
  history: { enabled: true, max: 50 },
  preferences: ["token"],
  overrides: { logs: { title: "Tail Logs" } }
})
