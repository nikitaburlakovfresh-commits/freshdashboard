module.exports = async function globalTeardown() {
  // Nothing persistent to release at the process level; per-test-file pools
  // are closed in each file's afterAll via closePool(). Kept as an explicit
  // no-op hook so the Jest config stays self-documenting.
};
