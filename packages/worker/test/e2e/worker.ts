/**
 * The Worker under test for the accounts end-to-end tests: src/index.ts itself, its fetch handler and every Durable Object
 * class it exports, so a request takes the route a deployed one takes.
 */
export * from "../../src/index.ts";
export { default } from "../../src/index.ts";
