import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: false,
        environment: "jsdom",
        setupFiles: ["./test/setup.ts"],
        include: ["test/smoke-tests/**/*.smoke.test.ts", "test/smoke-tests/**/*.smoke.test.tsx"],
        clearMocks: true,
        restoreMocks: true,
        mockReset: true,
        testTimeout: 20_000,
        hookTimeout: 20_000,
    },
});
