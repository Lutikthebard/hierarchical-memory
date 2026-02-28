function compareTimestamps(ts1, ts2) {
  if (!ts1 && !ts2) return 0;
  if (!ts1) return -1;
  if (!ts2) return 1;

  const t1 = new Date(ts1).getTime();
  const t2 = new Date(ts2).getTime();

  if (Number.isNaN(t1) || Number.isNaN(t2)) {
    throw new Error(`Invalid timestamp: ts1=${ts1}, ts2=${ts2}`);
  }

  if (t1 < t2) return -1;
  if (t1 > t2) return 1;
  return 0;
}

function formatTimestamp(timestamp) {
  if (!timestamp) return 'N/A';

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return 'Invalid timestamp';
  }

  return date.toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');
}

module.exports = {
  compareTimestamps,
  formatTimestamp
};
