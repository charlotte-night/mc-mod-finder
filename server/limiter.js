/** Small promise semaphore so we never hammer a public API. */
export function createLimiter(concurrency = 4) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
