import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: false,
        environment: "jsdom",
        setupFiles: ["./test/setup.ts"],
        include: ["test/unit-tests/**/*.test.ts", "test/unit-tests/**/*.test.tsx"],
        clearMocks: true,
        restoreMocks: true,
        mockReset: true,
    },
});
