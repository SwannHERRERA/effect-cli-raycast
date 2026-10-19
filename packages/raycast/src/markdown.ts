/** Markdown fragments for Raycast `Detail` screens. */
import { Boolean as Bool, Option } from "effect"

const FENCE = "```"
const BACKTICK = "`"

/** A fence longer than any backtick run inside `text`, so the block cannot be closed early. */
const fenceFor = (text: string, fence: string = FENCE): string =>
  Bool.match(text.includes(fence), { onTrue: () => fenceFor(text, `${fence}${BACKTICK}`), onFalse: () => fence })

export const codeBlock = (text: string, language: Option.Option<string>): string => {
  const fence = fenceFor(text)
  const opening = Option.match(language, { onNone: () => fence, onSome: (name) => `${fence}${name}` })
  return `${opening}\n${text.trimEnd()}\n${fence}`
}
