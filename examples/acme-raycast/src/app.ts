import { makeRaycast } from "effect-cli-raycast"
import config from "../raycast.config"

export const app = makeRaycast(config, {
  // Extension points (all optional):
  // widgets: { textarea: MyTextArea },
  // fields: { "acme.deploy.env": EnvPicker },
  // renderResult: (context) => <MyResult {...context} />,
  // onResult: (context) => track(context.leaf.command.path),
})
