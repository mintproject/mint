/* eslint-env node, jest */
// Integration test setup
// This file can be used to set up any global configuration needed for integration tests

// Increase timeout for all integration tests
jest.setTimeout(60000);

// Global error handling for unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Global error handling for uncaught exceptions
process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error);
});
