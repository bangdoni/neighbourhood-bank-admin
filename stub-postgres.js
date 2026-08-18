// Stub for postgres package — only used in postgres mode (DB_TYPE=postgres).
// D1 (sqlite) deployments never invoke this; it exists only to satisfy the bundler.
export default function postgres() {
  throw new Error('postgres: not available in D1/sqlite mode');
}
