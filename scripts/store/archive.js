const { createArchiveApi } = require('../store-archive');

function createStoreArchiveApi({ getDataDir, compareTimestamps }) {
  return createArchiveApi({
    getDataDir,
    compareTimestamps
  });
}

module.exports = {
  createStoreArchiveApi
};
