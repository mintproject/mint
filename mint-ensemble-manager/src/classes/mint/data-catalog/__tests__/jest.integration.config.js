/* eslint-env node, jest */
module.exports = {
    preset: "ts-jest",
    testEnvironment: "node",
    testMatch: ["**/*.integration.test.ts"],
    setupFilesAfterEnv: ["<rootDir>/jest.integration.setup.js"],
    testTimeout: 60000, // 60 seconds for integration tests
    verbose: true,
    collectCoverage: false, // Disable coverage for integration tests
    moduleNameMapper: {
        "^@/(.*)$": "<rootDir>/../../../../src/$1"
    },
    transform: {
        "^.+\\.ts$": "ts-jest"
    }
};
