import { Detail } from "@raycast/api"
import { Cause, Option } from "effect"
import { codeBlock } from "./markdown.ts"

/** Shown instead of a screen whose setup failed (bad config, unknown command, unreadable state). */
export const ErrorScreen = (props: { readonly title: string; readonly cause: Cause.Cause<unknown> }) => (
  <Detail markdown={`### ${props.title}\n\n${codeBlock(Cause.pretty(props.cause), Option.none())}`} />
)
