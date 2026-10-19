/**
 * Conditional list membership: `[...Include.when(isOptional, () => noChoice)]`
 * reads as the rule it encodes, where `cond ? [x] : []` hides it in syntax.
 */
import { Boolean as Bool } from "effect"
import type { LazyArg } from "effect/Function"

export const when = <A>(condition: boolean, value: LazyArg<A>): Array<A> =>
  Bool.match(condition, { onFalse: () => [], onTrue: () => [value()] })
