import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    // `@raycast/api` ships types only; Raycast injects the implementation at run time.
    alias: { "@raycast/api": fileURLToPath(new URL("./packages/raycast/test/raycast-api.ts", import.meta.url)) }
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"]
  }
})
