import { Meta } from "./Annotations.ts"

export * as Annotations from "./Annotations.ts"
export * as Argv from "./Argv.ts"
export * as Config from "./Config.ts"
export { defineConfig } from "./Config.ts"
export * as Field from "./Field.ts"
export * as Headless from "./Headless.ts"
export * as Include from "./Include.ts"
export * as Introspect from "./Introspect.ts"
export * as Manifest from "./Manifest.ts"
export * as Runner from "./Runner.ts"
export * as Source from "./Source.ts"
export * as Spec from "./Spec.ts"

/** CLI-side metadata: `Command.annotate(Raycast.Meta, { icon, mode, confirm })`. */
export const Raycast = { Meta } as const
